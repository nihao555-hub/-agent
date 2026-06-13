/**
 * 变更→索赔组卷提示词。
 * 原则（按产品要求）：只激活大模型作为「资深工程合同 / 计量计价 / 索赔专家」的领域判断，
 * 只描述要解决的问题，不灌关键词清单、不预设行业规则。结构化只为后端 API 稳定。
 * 关键约束：判断必须基于给定的合同/规范依据片段；每条结论尽量指回它引用的依据（cite 编号）。
 * 依据不足时如实说明并降级为「需人工确认」，绝不杜撰条款或金额。
 */

import type { BasisCitation, ChangeBrief, ImpactEstimate, InScopeJudgment } from './assembler';

export const CLAIM_SYSTEM_PROMPT = [
  '你是资深的工程合同与索赔专家，长期处理变更/签证认定、工期与费用索赔、计量计价与索赔组卷。',
  '你只依据给定的合同条款、技术规范、工程量等「依据片段」做判断，不臆测、不杜撰条款或数字。',
  '当依据不足以支撑结论时，如实指出并保持保守（标注需人工确认），不要编造。',
  '严格只输出 JSON，不要任何解释性文字或代码围栏。',
].join('\n');

/** 把依据片段渲染成带编号与定位的列表，供模型引用。 */
function renderBasis(basis: BasisCitation[]): string {
  if (basis.length === 0) return '（暂无可引用的合同/规范依据片段）';
  return basis
    .map((b, i) => {
      const loc = [b.page != null ? `p.${b.page}` : null, b.clause ? `§${b.clause}` : null]
        .filter(Boolean)
        .join(' ');
      const head = loc ? `[#${i} ${loc}]` : `[#${i}]`;
      return `${head} ${b.text}`;
    })
    .join('\n\n');
}

function renderChange(change: ChangeBrief): string {
  const lines = [`标题：${change.title}`];
  if (change.description) lines.push(`说明：${change.description}`);
  return lines.join('\n');
}

export function buildClassifyInScopePrompt(change: ChangeBrief, basis: BasisCitation[]): string {
  return [
    '【任务】用你的专业判断，结合下列合同/规范依据，判断这笔现场变更是否属于「原合同约定的承包范围」。',
    'yes=属于原范围（一般不另行计价）；no=超出原范围（可能构成可索赔的变更）；uncertain=依据不足以判定。',
    '【判断要点】对照原合同工作范围与技术规范，看变更内容是否已被原范围覆盖；依据不足时选 uncertain，不要硬判。',
    '【输出 JSON】{"inScope":"yes|no|uncertain","reason":"结论理由(指出依据要点；可引用 #编号)"}',
    '',
    '【变更内容】',
    renderChange(change),
    '',
    '【合同/规范依据片段】',
    renderBasis(basis),
  ].join('\n');
}

export function buildQuantifyImpactPrompt(change: ChangeBrief, basis: BasisCitation[]): string {
  return [
    '【任务】用你的专业判断，结合依据，评估这笔变更对项目的主要影响并给出索赔方向。',
    'claimType：time=以工期影响为主；cost=以费用影响为主。',
    'days：若主张工期，给出受影响的工期（自然日，整数；无法估算给 null）。',
    'amount：若主张费用，给出金额或计价口径的简述字符串（无法估算给 null，切勿编造具体数字）。',
    '【判断要点】只在依据支持时给出量化；依据不足时把数值留空并在 reason 说明需人工据实计量。',
    '【输出 JSON】{"claimType":"time|cost","days":int|null,"amount":"string|null","reason":"评估理由(可引用 #编号)"}',
    '',
    '【变更内容】',
    renderChange(change),
    '',
    '【依据片段（合同/规范/工程量等）】',
    renderBasis(basis),
  ].join('\n');
}

export function buildDraftNarrativePrompt(input: {
  change: ChangeBrief;
  judgment: InScopeJudgment;
  impact: ImpactEstimate;
  basis: BasisCitation[];
}): string {
  const { change, judgment, impact, basis } = input;
  return [
    '【任务】基于以下已认定的事实，起草一段专业、可提交给业主/监理的「索赔/变更说明」正文。',
    '要求：陈述变更事实→说明是否超出合同范围及依据→说明影响（工期/费用）→提出索赔主张。',
    '【写作要求】语言专业克制；只依据给定信息，引用依据时写明其条款/页码定位；',
    '凡依据不足之处，明确写「需人工据实补充/计量」，不得编造条款号或金额。直接输出正文，不要标题或解释。',
    '',
    `【范围认定】${judgment.inScope}：${judgment.reason}`,
    `【影响评估】方向=${impact.claimType}；工期=${impact.days ?? '待定'}；费用=${impact.amount ?? '待定'}；理由=${impact.reason}`,
    '',
    '【变更内容】',
    renderChange(change),
    '',
    '【可引用依据片段】',
    renderBasis(basis),
  ].join('\n');
}
