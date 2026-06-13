/**
 * 事实底座抽取提示词。
 * 原则（按产品要求）：只激活大模型作为「资深工程招投标 / 合同交付专家」的领域判断，
 * 只告诉它要解决什么问题，不灌关键词清单、不预设行业规则。结构化只为后端 API 稳定。
 * 关键约束：每条结论必须标注它来自哪个片段（chunkIndex），做到「带原文出处」、可追溯。
 */

import type { Chunk } from './types';

export const FACTBASE_SYSTEM_PROMPT = [
  '你是资深的工程招投标与合同交付专家，长期负责招标文件解读、合同义务梳理、范围与偏差识别、变更与索赔。',
  '你的任务是把工程文档转化为「可追溯的事实」：每一条结论都要能指回它的原文出处（片段编号）。',
  '只依据给定原文做判断，不臆测、不杜撰；原文不支持的结论一律不要输出。',
  '严格只输出 JSON，不要任何解释性文字或代码围栏。',
].join('\n');

/** 把片段渲染成带编号与定位的列表，供模型引用 chunkIndex。 */
function renderChunks(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => {
      const loc = [c.page != null ? `p.${c.page}` : null, c.clause ? `§${c.clause}` : null]
        .filter(Boolean)
        .join(' ');
      const head = loc ? `[#${i} ${loc}]` : `[#${i}]`;
      return `${head} ${c.text}`;
    })
    .join('\n\n');
}

export function buildExtractRequirementsPrompt(chunks: Chunk[]): string {
  return [
    '【任务】用你的专业判断，从下列文档片段中抽取所有对投标人/承包人构成约束的「要求」（资质资格、评分办法、废标/否决项、关键时间节点、技术要求、商务要求、合同义务等）。',
    '【判断要点】凭专业经验识别哪些是真正的硬约束、哪些可选；同一含义不要重复抽取；',
    '为每条要求选择最贴切的 kind，并判断是否强制(mandatory)与严重度(severity)。',
    '【溯源】每条都必须给出它来自哪个片段编号 chunkIndex（见下方 [#编号]）。',
    '【输出 JSON】{"items":[{"chunkIndex":int,"kind":"qualification|scoring|disqualification|milestone|technical|commercial|contract_clause","category":"简短分类(可选)","text":"要求原意(简洁完整)","mandatory":bool,"severity":"low|medium|high"}]}',
    '',
    '【文档片段】',
    renderChunks(chunks),
  ].join('\n');
}

export function buildExtractCommitmentsPrompt(chunks: Chunk[]): string {
  return [
    '【任务】用你的专业判断，从下列「我方文档」（投标文件/技术与商务方案/合同响应）片段中，抽取我方对外做出的「承诺」（响应、指标、工期、服务、配置、价格条件等）。',
    '【判断要点】只抽我方主动作出的、可被对方据以追责的承诺；含糊的意向不要当承诺。',
    '【溯源】每条都必须给出它来自哪个片段编号 chunkIndex。',
    '【输出 JSON】{"items":[{"chunkIndex":int,"kind":"承诺类型(可选,如技术/商务/工期/服务)","text":"承诺原意(简洁完整)"}]}',
    '',
    '【我方文档片段】',
    renderChunks(chunks),
  ].join('\n');
}

export function buildDetectDeviationsPrompt(
  requirements: Array<{ index: number; text: string; kind: string; mandatory: boolean }>,
  commitments: Array<{ index: number; text: string }>,
): string {
  const reqList = requirements
    .map((r) => `[R#${r.index}] (${r.kind}${r.mandatory ? ',强制' : ''}) ${r.text}`)
    .join('\n');
  const comList = commitments.length
    ? commitments.map((c) => `[C#${c.index}] ${c.text}`).join('\n')
    : '（暂无我方承诺记录）';
  return [
    '【任务】用你的专业判断，逐条比对「要求」与「我方承诺」，找出偏差：',
    'missing=完全未响应；partial=部分响应/不充分；conflict=承诺与要求冲突；over_commit=超出要求的过度承诺(增加风险/成本)。',
    '【判断要点】考虑同义/等价响应，不要只看字面；只输出真实存在的偏差，能对上的不要报偏差。',
    '【溯源】每条偏差给出对应的 requirementIndex；若与某条承诺相关，给出 commitmentIndex。',
    '【输出 JSON】{"items":[{"requirementIndex":int,"commitmentIndex":int|null,"type":"missing|partial|conflict|over_commit","severity":"low|medium|high","description":"偏差说明(指出缺什么/差在哪)"}]}',
    '',
    '【要求清单】',
    reqList,
    '',
    '【我方承诺清单】',
    comList,
  ].join('\n');
}
