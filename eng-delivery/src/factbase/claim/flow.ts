import { HttpError } from '../../errors';
import type { FlowStepDefinition } from '../../flow/orchestrator';
import type { ChunkHit, InScope } from '../types';
import type { BasisCitation, ChangeBrief, ClaimAssembler, ImpactEstimate } from './assembler';
import type {
  ChangeRepository,
  ClaimRepository,
  EvidenceRepository,
  LinkRepository,
  ProjectEventRepository,
} from '../../db/factbase';

/** 变更→索赔长流程的步骤名（稳定标识，落库/审计/续跑都用它）。 */
export const CLAIM_FLOW_KIND = 'change_claim';
export const CLAIM_FLOW_STEPS = [
  'classify_in_scope',
  'gather_contract_basis',
  'quantify_impact',
  'draft_claim_narrative',
  'compile_packet',
] as const;

const TOP_K = 6;

/** 组卷流程依赖：检索（RAG）+ 相关仓储 + 智能组卷器。 */
export interface ClaimFlowDeps {
  changes: ChangeRepository;
  claims: ClaimRepository;
  evidences: EvidenceRepository;
  links: LinkRepository;
  events: ProjectEventRepository;
  assembler: ClaimAssembler;
  retrieve: (projectId: string, query: string, topK: number) => Promise<ChunkHit[]>;
}

/** 步骤间累积、随断点续跑恢复的共享状态。 */
interface ClaimFlowState {
  basis?: BasisCitation[];
  inScope?: InScope;
  classifyReason?: string;
  evidenceIds?: string[];
  impact?: ImpactEstimate;
  narrative?: string;
  claimId?: string;
}

function briefOf(change: { title: string; description?: string }): ChangeBrief {
  return { title: change.title, description: change.description };
}

/** 用变更自身的文字作为检索 query（不灌关键词，让向量检索去找最相关的合同/规范依据）。 */
function queryOf(change: { title: string; description?: string }): string {
  return [change.title, change.description].filter(Boolean).join('。');
}

function citationOf(hit: ChunkHit): BasisCitation {
  return {
    chunkId: hit.id,
    page: hit.page,
    clause: hit.clause,
    text: hit.text,
    score: hit.score,
  };
}

function locOf(b: BasisCitation): string {
  return [b.page != null ? `p.${b.page}` : null, b.clause ? `§${b.clause}` : null]
    .filter(Boolean)
    .join(' ');
}

/**
 * 组装「变更→索赔」长流程的步骤定义。流程「长什么样」在此用代码声明，运行态由编排器落库，
 * 因此可断点续跑（崩溃后用这同一份定义 + 落库 cursor 从未完成步骤继续）。
 * 每一步的专业判断都委托给注入的 assembler（大模型优先，失败回退薄兜底），并基于检索到的依据，
 * 保证「带原文出处、可追溯」；薄兜底路径会把结论保守标注为需人工确认。
 */
export function buildClaimFlow(deps: ClaimFlowDeps): FlowStepDefinition[] {
  const loadChange = (changeId: string) => {
    const change = deps.changes.get(changeId);
    if (!change) throw new HttpError(404, `变更不存在: ${changeId}`);
    return change;
  };

  return [
    // 1) 范围认定：检索合同/规范依据 → 判断是否超出原合同承包范围。
    {
      name: 'classify_in_scope',
      async run(ctx) {
        const change = loadChange(ctx.run.subjectId);
        const hits = await deps.retrieve(ctx.run.projectId, queryOf(change), TOP_K);
        const basis = hits.map(citationOf);
        const judgment = await deps.assembler.classifyInScope(briefOf(change), basis);
        deps.changes.update(change.id, { inScope: judgment.inScope });
        return {
          state: { basis, inScope: judgment.inScope, classifyReason: judgment.reason },
          output: {
            inScope: judgment.inScope,
            reason: judgment.reason,
            citations: basis.map((b) => ({ chunkId: b.chunkId, loc: locOf(b), score: b.score })),
          },
        };
      },
    },

    // 2) 归集依据：把检索到的依据固化为可追溯的 evidence 结点（供索赔引用）。
    {
      name: 'gather_contract_basis',
      async run(ctx) {
        const state = ctx.state as ClaimFlowState;
        const basis = state.basis ?? [];
        const evidenceIds = basis.map((b) => {
          const ev = deps.evidences.create({
            projectId: ctx.run.projectId,
            chunkId: b.chunkId,
            note: `索赔依据 ${locOf(b)}`.trim(),
          });
          return ev.id;
        });
        return {
          state: { evidenceIds },
          output: { evidenceCount: evidenceIds.length },
        };
      },
    },

    // 3) 影响量化：评估工期/费用影响与索赔方向（依据不足则留空待人工计量）。
    {
      name: 'quantify_impact',
      async run(ctx) {
        const state = ctx.state as ClaimFlowState;
        const change = loadChange(ctx.run.subjectId);
        const impact = await deps.assembler.quantifyImpact(briefOf(change), state.basis ?? []);
        return {
          state: { impact },
          output: {
            claimType: impact.claimType,
            days: impact.days ?? null,
            amount: impact.amount ?? null,
            reason: impact.reason,
          },
        };
      },
    },

    // 4) 起草正文：基于已认定事实与依据，生成可提交的索赔/变更说明正文。
    {
      name: 'draft_claim_narrative',
      async run(ctx) {
        const state = ctx.state as ClaimFlowState;
        const change = loadChange(ctx.run.subjectId);
        const narrative = await deps.assembler.draftNarrative({
          change: briefOf(change),
          judgment: {
            inScope: state.inScope ?? 'uncertain',
            reason: state.classifyReason ?? '',
          },
          impact: state.impact ?? { claimType: 'cost', reason: '' },
          basis: state.basis ?? [],
        });
        return {
          state: { narrative },
          output: { length: narrative.length },
        };
      },
    },

    // 5) 组卷：落库 claim 结点，连边 claim→变更/证据/原文，更新变更状态，留痕事件。
    {
      name: 'compile_packet',
      async run(ctx) {
        const state = ctx.state as ClaimFlowState;
        const change = loadChange(ctx.run.subjectId);
        const basis = state.basis ?? [];
        const impact = state.impact ?? { claimType: 'cost' as const, reason: '' };
        const basisSummary = basis.length
          ? `基于 ${basis.map(locOf).filter(Boolean).join('；') || `${basis.length} 处依据`}`
          : '需人工补充合同/规范依据';

        const claim = deps.claims.create({
          projectId: ctx.run.projectId,
          changeId: change.id,
          type: impact.claimType,
          basis: basisSummary,
          amount: impact.amount,
          days: impact.days,
          narrative: state.narrative,
          status: 'draft',
        });

        // claim 溯源到变更
        deps.links.create({
          projectId: ctx.run.projectId,
          fromType: 'claim',
          fromId: claim.id,
          toType: 'change',
          toId: change.id,
          relation: 'derived_from',
        });
        // claim 溯源到证据与原文片段
        (state.evidenceIds ?? []).forEach((evId) => {
          deps.links.create({
            projectId: ctx.run.projectId,
            fromType: 'claim',
            fromId: claim.id,
            toType: 'evidence',
            toId: evId,
            relation: 'evidenced_by',
          });
        });
        basis.forEach((b) => {
          deps.links.create({
            projectId: ctx.run.projectId,
            fromType: 'claim',
            fromId: claim.id,
            toType: 'chunk',
            toId: b.chunkId,
            relation: 'cited_from',
          });
        });

        deps.changes.update(change.id, { status: 'claimed' });
        deps.events.create(ctx.run.projectId, 'claim_assembled', {
          claimId: claim.id,
          changeId: change.id,
          engine: deps.assembler.name,
          inScope: state.inScope ?? 'uncertain',
          type: claim.type,
        });

        return {
          state: { claimId: claim.id },
          output: { claimId: claim.id, type: claim.type, status: claim.status },
        };
      },
    },
  ];
}
