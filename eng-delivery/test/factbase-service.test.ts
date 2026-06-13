import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db';
import {
  ChangeRepository,
  ChunkRepository,
  ClaimRepository,
  CommitmentRepository,
  DeviationRepository,
  DocumentRepository,
  EvidenceRepository,
  LinkRepository,
  ProjectEventRepository,
  ProjectRepository,
  RequirementRepository,
} from '../src/db/factbase';
import { BimAnalyzer, type BimModel } from '../src/bim/client';
import { DocAnalyzer } from '../src/doc/structured';
import { HashEmbeddingClient } from '../src/factbase/embeddings';
import { RuleFactExtractor } from '../src/factbase/extractor';
import { FactBaseService } from '../src/factbase/service';

/** 离线 BIM 桩：跳过 HTTP，直接返回给定模型，便于测试 BIM 事实落库/检索。 */
class StubBimAnalyzer extends BimAnalyzer {
  constructor(private readonly model: BimModel) {
    super({ timeoutMs: 1 });
  }
  override async analyze(): Promise<BimModel> {
    return this.model;
  }
}

function buildService(db: Db, bim: BimAnalyzer = new BimAnalyzer({ timeoutMs: 1000 })): FactBaseService {
  return new FactBaseService(
    {
      projects: new ProjectRepository(db),
      documents: new DocumentRepository(db),
      chunks: new ChunkRepository(db),
      requirements: new RequirementRepository(db),
      commitments: new CommitmentRepository(db),
      deviations: new DeviationRepository(db),
      evidences: new EvidenceRepository(db),
      changes: new ChangeRepository(db),
      claims: new ClaimRepository(db),
      links: new LinkRepository(db),
      events: new ProjectEventRepository(db),
    },
    new RuleFactExtractor(),
    new DocAnalyzer({ timeoutMs: 1000 }),
    new HashEmbeddingClient(),
    bim,
  );
}

const REQ_A = '投标人须具备市政公用工程施工总承包二级及以上资质';
const REQ_B = '投标人应提供近三年类似工程业绩不少于三项';
const TENDER_TEXT = `${REQ_A}。\n\n${REQ_B}。`;

describe('FactBaseService 事实图谱编排（规则兜底离线）', () => {
  let db: Db;
  let service: FactBaseService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    service = buildService(db);
  });

  it('录入文档 → 机械切片为可引用 chunk', async () => {
    const project = service.createProject({ name: '某污水处理厂工程' });
    const ingest = await service.ingestDocument(project.id, { type: 'tender', text: TENDER_TEXT });
    expect(ingest.chunkCount).toBe(2);
    expect(ingest.document.parsed).toBe(true);
    expect(ingest.chunks[0].text).toContain('二级');
  });

  it('抽取要求基线，每条带原文出处(cited_from 边)', async () => {
    const project = service.createProject({ name: 'P' });
    await service.ingestDocument(project.id, { type: 'tender', text: TENDER_TEXT });
    const { requirements } = await service.extractRequirements(project.id);
    expect(requirements).toHaveLength(2);
    expect(requirements.every((r) => r.sourceChunkId)).toBe(true);

    const graph = service.getGraph(project.id);
    const citedFrom = graph.links.filter(
      (l) => l.fromType === 'requirement' && l.relation === 'cited_from' && l.toType === 'chunk',
    );
    expect(citedFrom).toHaveLength(2);
  });

  it('偏离检测：未响应的强制要求被标 at_risk 并连边到 deviation', async () => {
    const project = service.createProject({ name: 'P' });
    const tender = await service.ingestDocument(project.id, { type: 'tender', text: TENDER_TEXT });
    await service.extractRequirements(project.id, tender.document.id);
    // 我方投标只覆盖了 REQ_A（原样响应），未覆盖 REQ_B
    const bid = await service.ingestDocument(project.id, { type: 'bid', text: REQ_A });
    await service.extractCommitments(project.id, bid.document.id);

    const { deviations } = await service.detectDeviations(project.id);
    expect(deviations.length).toBeGreaterThanOrEqual(1);

    const graph = service.getGraph(project.id);
    const reqB = graph.requirements.find((r) => r.text.includes('业绩'));
    const reqA = graph.requirements.find((r) => r.text.includes('资质'));
    expect(reqB?.status).toBe('at_risk');
    // REQ_A 被原样响应，相似度高，不应产生偏离
    expect(reqA?.status).toBe('open');

    const aboutEdges = graph.links.filter(
      (l) => l.fromType === 'deviation' && l.relation === 'about',
    );
    expect(aboutEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('getGraph 汇总统计与事件链', async () => {
    const project = service.createProject({ name: 'P' });
    await service.ingestDocument(project.id, { type: 'tender', text: TENDER_TEXT });
    await service.extractRequirements(project.id);
    service.recordChange(project.id, { title: '增加一道防水工序' });

    const graph = service.getGraph(project.id);
    expect(graph.stats.documents).toBe(1);
    expect(graph.stats.chunks).toBe(2);
    expect(graph.stats.requirements).toBe(2);
    expect(graph.stats.changes).toBe(1);
    // 事件链：project_created → document_ingested → requirements_extracted → change_recorded
    expect(graph.events.length).toBeGreaterThanOrEqual(4);
    expect(graph.events[0].type).toBe('project_created');
  });

  it('未知项目抛 404', async () => {
    await expect(service.extractRequirements('no-project')).rejects.toMatchObject({ status: 404 });
  });

  it('带引用检索：命中相关片段并溯源到条款，按分数倒序', async () => {
    const project = service.createProject({ name: 'P' });
    await service.ingestDocument(project.id, {
      type: 'tender',
      text: `${REQ_A}。\n\n${REQ_B}。`,
    });
    const { hits, engine } = await service.search(project.id, '类似工程业绩要求', 5);
    expect(engine).toBe('hash');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // 最相关命中应是“业绩”那条
    expect(hits[0].text).toContain('业绩');
    expect(hits[0].score).toBeGreaterThan(0);
    // 分数倒序
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it('无匹配/空库检索返回空命中', async () => {
    const project = service.createProject({ name: 'P' });
    const res = await service.search(project.id, '任意查询', 5);
    expect(res.hits).toHaveLength(0);
  });

  it('录入 BIM 模型 → 空间/构件/工程量沉淀为可检索引用的事实', async () => {
    const bimSvc = buildService(
      db,
      new StubBimAnalyzer({
        spaces: [{ name: '泵房', area: 120 }],
        elements: [{ type: 'IfcWall', material: 'C30混凝土', quantities: { volume: 35 } }],
        quantities: [{ name: '混凝土总量', value: 1200, unit: 'm³' }],
      }),
    );
    const project = bimSvc.createProject({ name: '某污水处理厂工程' });
    const ingest = await bimSvc.ingestBim(project.id, { fileBase64: 'AAAA', fileName: 'm.ifc' });
    expect(ingest.document.type).toBe('bim');
    expect(ingest.chunkCount).toBe(3);

    const graph = bimSvc.getGraph(project.id);
    expect(graph.events.some((e) => e.type === 'bim_ingested')).toBe(true);

    const { hits } = await bimSvc.search(project.id, '混凝土工程量');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('未配 BIM 服务时录入 IFC 返回 503', async () => {
    const project = service.createProject({ name: 'P' });
    await expect(service.ingestBim(project.id, { fileBase64: 'AAAA' })).rejects.toMatchObject({
      status: 503,
    });
  });
});
