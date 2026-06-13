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
import { FlowRunRepository, FlowStepRepository } from '../src/db/flow';
import { BimAnalyzer } from '../src/bim/client';
import { DocAnalyzer } from '../src/doc/structured';
import {
  RuleClaimAssembler,
  type BasisCitation,
  type ChangeBrief,
  type ClaimAssembler,
  type ImpactEstimate,
  type InScopeJudgment,
} from '../src/factbase/claim/assembler';
import { HashEmbeddingClient } from '../src/factbase/embeddings';
import { RuleFactExtractor } from '../src/factbase/extractor';
import { FactBaseService } from '../src/factbase/service';

function buildService(db: Db, assembler: ClaimAssembler): FactBaseService {
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
      flowRuns: new FlowRunRepository(db),
      flowSteps: new FlowStepRepository(db),
    },
    new RuleFactExtractor(),
    new DocAnalyzer({ timeoutMs: 1000 }),
    new HashEmbeddingClient(),
    new BimAnalyzer({ timeoutMs: 1000 }),
    assembler,
  );
}

/** 第一次 quantifyImpact 抛错、之后正常的组卷器，用来验证长流程断点续跑 + 幂等。 */
class FlakyAssembler implements ClaimAssembler {
  readonly name = 'rule-based';
  private readonly inner = new RuleClaimAssembler();
  quantifyCalls = 0;

  classifyInScope(change: ChangeBrief, basis: BasisCitation[]): Promise<InScopeJudgment> {
    return this.inner.classifyInScope(change, basis);
  }

  async quantifyImpact(change: ChangeBrief, basis: BasisCitation[]): Promise<ImpactEstimate> {
    this.quantifyCalls++;
    if (this.quantifyCalls === 1) throw new Error('quantify boom');
    return this.inner.quantifyImpact(change, basis);
  }

  draftNarrative(input: {
    change: ChangeBrief;
    judgment: InScopeJudgment;
    impact: ImpactEstimate;
    basis: BasisCitation[];
  }): Promise<string> {
    return this.inner.draftNarrative(input);
  }
}

const CONTRACT_TEXT = [
  '承包范围包括土建主体结构施工及附属工程。',
  '防水工程按设计图纸及国家现行规范施工，验收合格后方可进入下道工序。',
  '因业主原因导致的工程变更，承包人有权就工期与费用提出索赔。',
].join('\n\n');

const CHANGE = {
  title: '业主新增地下室外墙防水工序',
  description: '现场签证要求增加一道 SBS 防水卷材，超出原合同承包范围。',
};

async function seedProjectWithChange(service: FactBaseService) {
  const project = service.createProject({ name: '某污水处理厂工程' });
  await service.ingestDocument(project.id, { type: 'contract', text: CONTRACT_TEXT });
  const change = service.recordChange(project.id, CHANGE);
  return { project, change };
}

describe('变更→索赔自动组卷长流程（离线、规则兜底）', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('happy path：一次跑通，产出带引用与连边的索赔，并回写变更状态', async () => {
    const service = buildService(db, new RuleClaimAssembler());
    const { project, change } = await seedProjectWithChange(service);

    const result = await service.assembleClaim(change.id);

    // run 完成、每一步都完成
    expect(result.run.status).toBe('completed');
    expect(result.steps.map((s) => s.name)).toEqual([
      'classify_in_scope',
      'gather_contract_basis',
      'quantify_impact',
      'draft_claim_narrative',
      'compile_packet',
    ]);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);

    // 产出一条索赔，溯源到变更
    expect(result.claim).toBeDefined();
    expect(result.claim?.changeId).toBe(change.id);
    expect(result.claim?.status).toBe('draft');
    expect(result.claim?.narrative).toBeTruthy();

    const graph = service.getGraph(project.id);
    expect(graph.claims).toHaveLength(1);
    // 变更被回写：状态 claimed、范围认定已填（规则兜底为 uncertain）
    const updatedChange = graph.changes.find((c) => c.id === change.id);
    expect(updatedChange?.status).toBe('claimed');
    expect(updatedChange?.inScope).toBe('uncertain');

    // 连边：claim→change(derived_from)、claim→chunk(cited_from)、claim→evidence(evidenced_by)
    const claimLinks = graph.links.filter((l) => l.fromType === 'claim');
    expect(claimLinks.some((l) => l.relation === 'derived_from' && l.toType === 'change')).toBe(true);
    expect(claimLinks.some((l) => l.relation === 'cited_from' && l.toType === 'chunk')).toBe(true);
    expect(claimLinks.some((l) => l.relation === 'evidenced_by' && l.toType === 'evidence')).toBe(
      true,
    );
    // 检索到合同依据，沉淀为可追溯证据
    expect(graph.evidences.length).toBeGreaterThanOrEqual(1);
    // 留痕事件
    expect(graph.events.some((e) => e.type === 'claim_assembled')).toBe(true);
  });

  it('断点续跑：中途失败可恢复，最终只产出一条索赔（幂等、不重复证据）', async () => {
    const flaky = new FlakyAssembler();
    const service = buildService(db, flaky);
    const { project, change } = await seedProjectWithChange(service);

    // 第一次：在 quantify_impact 失败，停在断点，尚未组卷
    const failed = await service.assembleClaim(change.id);
    expect(failed.run.status).toBe('failed');
    expect(failed.run.cursor).toBe(2);
    expect(failed.claim).toBeUndefined();
    expect(failed.steps[0].status).toBe('completed'); // classify
    expect(failed.steps[1].status).toBe('completed'); // gather basis
    expect(failed.steps[2].status).toBe('failed'); // quantify

    const evidenceAfterFail = service.getGraph(project.id).evidences.length;
    expect(service.getGraph(project.id).claims).toHaveLength(0);

    // 续跑：从 quantify_impact 继续到组卷完成
    const done = await service.resumeFlow(failed.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.claim).toBeDefined();
    expect(flaky.quantifyCalls).toBe(2); // 失败一次 + 成功一次

    const graph = service.getGraph(project.id);
    // 幂等：恰好一条索赔；证据不因续跑重复生成（gather_contract_basis 未重跑）
    expect(graph.claims).toHaveLength(1);
    expect(graph.evidences.length).toBe(evidenceAfterFail);
    expect(graph.changes.find((c) => c.id === change.id)?.status).toBe('claimed');
    expect(graph.events.filter((e) => e.type === 'claim_assembled')).toHaveLength(1);
  });

  it('未知变更抛 404；未知流程续跑/查询抛 404', async () => {
    const service = buildService(db, new RuleClaimAssembler());
    await expect(service.assembleClaim('no-change')).rejects.toMatchObject({ status: 404 });
    await expect(service.resumeFlow('no-run')).rejects.toMatchObject({ status: 404 });
    expect(() => service.getFlow('no-run')).toThrowError();
  });
});
