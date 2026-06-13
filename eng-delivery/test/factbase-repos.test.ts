import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db';
import {
  ChunkRepository,
  CommitmentRepository,
  DeviationRepository,
  DocumentRepository,
  LinkRepository,
  ProjectEventRepository,
  ProjectRepository,
  RequirementRepository,
} from '../src/db/factbase';

describe('事实底座仓储（内存库）', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('ProjectRepository 默认状态 bidding，可流转', () => {
    const repo = new ProjectRepository(db);
    const p = repo.create({ name: '某地铁站工程' });
    expect(p.status).toBe('bidding');
    expect(repo.get(p.id)?.name).toBe('某地铁站工程');
    repo.setStatus(p.id, 'awarded');
    expect(repo.get(p.id)?.status).toBe('awarded');
    expect(repo.list()).toHaveLength(1);
  });

  it('Document/Chunk 归集到项目，markParsed 更新页数', () => {
    const projects = new ProjectRepository(db);
    const docs = new DocumentRepository(db);
    const chunks = new ChunkRepository(db);
    const p = projects.create({ name: 'P' });
    const doc = docs.create({ projectId: p.id, type: 'tender', title: '招标文件' });
    expect(doc.parsed).toBe(false);

    const created = chunks.createMany([
      { documentId: doc.id, projectId: p.id, ordinal: 0, text: '片段一', clause: '3.1' },
      { documentId: doc.id, projectId: p.id, ordinal: 1, text: '片段二', page: 2 },
    ]);
    expect(created).toHaveLength(2);
    docs.markParsed(doc.id, 2);
    expect(docs.get(doc.id)?.parsed).toBe(true);
    expect(docs.get(doc.id)?.pageCount).toBe(2);
    expect(chunks.listByProject(p.id)).toHaveLength(2);
    expect(chunks.listByDocument(doc.id)[0].clause).toBe('3.1');
  });

  it('Requirement/Commitment/Deviation 关联与状态', () => {
    const projects = new ProjectRepository(db);
    const reqs = new RequirementRepository(db);
    const coms = new CommitmentRepository(db);
    const devs = new DeviationRepository(db);
    const p = projects.create({ name: 'P' });

    const req = reqs.create({ projectId: p.id, kind: 'qualification', text: '需二级资质', mandatory: true });
    expect(req.status).toBe('open');
    reqs.setStatus(req.id, 'at_risk');
    expect(reqs.get(req.id)?.status).toBe('at_risk');

    const com = coms.create({ projectId: p.id, text: '我方具备一级资质' });
    const dev = devs.create({
      projectId: p.id,
      requirementId: req.id,
      commitmentId: com.id,
      type: 'partial',
      description: '响应不充分',
    });
    expect(dev.detectedBy).toBe('llm');
    expect(devs.listByProject(p.id)).toHaveLength(1);
  });

  it('LinkRepository 记录图谱边并可按起点过滤', () => {
    const projects = new ProjectRepository(db);
    const links = new LinkRepository(db);
    const p = projects.create({ name: 'P' });
    links.create({
      projectId: p.id,
      fromType: 'requirement',
      fromId: 'r1',
      toType: 'chunk',
      toId: 'c1',
      relation: 'cited_from',
    });
    links.create({
      projectId: p.id,
      fromType: 'deviation',
      fromId: 'd1',
      toType: 'requirement',
      toId: 'r1',
      relation: 'about',
    });
    expect(links.listByProject(p.id)).toHaveLength(2);
    expect(links.listFrom('requirement', 'r1')).toHaveLength(1);
  });

  it('ProjectEvent 按时间升序', () => {
    const projects = new ProjectRepository(db);
    const events = new ProjectEventRepository(db);
    const p = projects.create({ name: 'P' });
    events.create(p.id, 'a', { n: 1 });
    events.create(p.id, 'b', { n: 2 });
    const evs = events.listByProject(p.id);
    expect(evs.map((e) => e.type)).toEqual(['a', 'b']);
    expect(evs[1].detail.n).toBe(2);
  });

  it('外键约束：chunk 引用不存在的文档应被拒绝', () => {
    const projects = new ProjectRepository(db);
    const chunks = new ChunkRepository(db);
    const p = projects.create({ name: 'P' });
    expect(() =>
      chunks.create({ documentId: 'no-doc', projectId: p.id, ordinal: 0, text: 'x' }),
    ).toThrow();
  });
});
