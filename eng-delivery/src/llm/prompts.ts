import { COMPLIANCE_STATUS, COVERAGE_STATUS, type CapabilityProfile, type TenderSpec } from '../types';

/**
 * 系统提示：激活大模型在工程招投标领域的专家级知识，而不是给它灌一份规则清单。
 * 只约定「职业身份 + 工作纪律 + 输出格式」，至于「什么算资质、什么会废标、节点怎么识别」，
 * 全部交给模型用自己的领域经验判断（产品要求：不硬编码领域规则）。
 */
export const SYSTEM_PROMPT = [
  '你是一名资深的工程招投标专家与标书工程师，长期负责工程总承包(EPC)、施工、监理、设计、政府采购等项目的招标文件研读、投标策划与符合性自检。',
  '你熟悉《招标投标法》《政府采购法》及其实施条例、评标办法（综合评分法/最低评标价法等）、资格审查与废标（否决投标）的常见情形。',
  '请用你的专家判断来完成任务，而不是机械套用关键词。',
  '工作纪律：',
  '1) 只输出 JSON，不要任何解释、前后缀或 markdown 代码块；',
  '2) 使用简体中文；严格按给定字段名与结构输出；',
  '3) 严禁编造招标文件中不存在的内容；原文未写明的，对应字段留空或在结论中标注「需人工确认」，绝不臆测；',
  '4) 凡涉及具体要求/条款，尽量在 source 字段回填可追溯的原文出处（条款号、章节名或关键原句片段），便于人工复核；',
  '5) 结论要给出可追溯的依据，基于招标文件与我方资料的客观事实。',
].join('\n');

export function buildParseTenderPrompt(input: { text: string; projectName?: string }): string {
  return [
    '【任务】把下面这份招标文件（可能是节选）研读后，抽取成结构化要点。重点抽取四类信息：',
    '① 投标人资质/资格要求（requirements）：营业执照范围、资质等级、安全生产许可、类似业绩、财务、注册人员、体系认证等；逐条列出，并判断每条是否为强制项（mandatory，不满足即资格不符/废标）。',
    '② 评分办法（scoringItems）：各评分项名称、分值(maxScore)、评分标准(criteria)、维度类别(category，如技术分/商务分/价格分)。',
    '③ 废标/否决投标条款（disqualifications）：会被认定为废标或无效投标的情形。',
    '④ 关键时间节点（milestones）：投标截止、开标、答疑/澄清截止、保证金缴纳、踏勘等，date 尽量保留原文表述。',
    '同时尽量抽取项目名称、招标人(tenderer)、代理机构(agent)、招标方式(method)、预算/最高限价(budget)、投标保证金(bidSecurity)。',
    input.projectName ? `已知项目名称：${input.projectName}` : '',
    '【招标文件文本】',
    input.text,
    '',
    'requirements[].id 用 R1、R2… 顺序编号。category 由你按专业判断填写自由文本，不要拘泥固定清单。',
    '原文未提供的字段一律省略或留空，严禁编造。',
    '【只输出如下 JSON】',
    '{"projectName":"","tenderer":"","agent":"","method":"","budget":"","bidSecurity":"","requirements":[{"id":"R1","category":"","text":"","mandatory":false,"source":""}],"scoringItems":[{"name":"","maxScore":0,"criteria":"","category":"","source":""}],"disqualifications":[{"text":"","trigger":"","source":""}],"milestones":[{"name":"","date":"","note":"","source":""}],"summary":""}',
  ]
    .filter(Boolean)
    .join('\n');
}

function tenderBrief(tender: TenderSpec): string {
  const reqs = tender.requirements
    .map(
      (r) =>
        `${r.id}｜[${r.category || '未分类'}]${r.mandatory ? '（强制）' : ''} ${r.text}${
          r.source ? `（出处：${r.source}）` : ''
        }`,
    )
    .join('\n');
  const dq = tender.disqualifications
    .map((d, i) => `D${i + 1}. ${d.text}${d.trigger ? `（触发：${d.trigger}）` : ''}`)
    .join('\n');
  return [
    tender.projectName ? `项目：${tender.projectName}` : '',
    tender.method ? `招标方式：${tender.method}` : '',
    tender.budget ? `预算/限价：${tender.budget}` : '',
    reqs ? `【资质/资格要求】\n${reqs}` : '',
    dq ? `【废标/否决条款】\n${dq}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function capabilityBrief(cap: CapabilityProfile): string {
  return [
    cap.companyName ? `单位：${cap.companyName}` : '',
    cap.qualifications?.length ? `资质：${cap.qualifications.join('；')}` : '',
    cap.pastProjects?.length ? `业绩：${cap.pastProjects.join('；')}` : '',
    cap.team?.length ? `人员：${cap.team.join('；')}` : '',
    cap.finance ? `财务：${cap.finance}` : '',
    cap.techCapabilities?.length ? `技术能力：${cap.techCapabilities.join('；')}` : '',
    cap.narrative ? `补充：${cap.narrative}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildGapPrompt(tender: TenderSpec, cap: CapabilityProfile): string {
  return [
    '【任务】做「范围/资格缺口检测」：用你的专业经验，把招标的每一条资质/资格要求与我方能力做语义比对（考虑同义、等价资质、上位覆盖，而不是字面匹配），判断覆盖情况并给出缺口与补强建议。',
    '【招标要点】',
    tenderBrief(tender),
    '【我方能力资料】',
    capabilityBrief(cap) || '（未提供我方资料，请将相应条目标注为「需人工确认」）',
    '',
    `findings 必须覆盖招标要点中列出的每一条要求（按其 R 编号回填 requirementId）。coverage 取值：${COVERAGE_STATUS.join(' / ')}。`,
    'severity 取 low/medium/high：强制项未覆盖应判 high。matched 写命中的我方资料，gap 写缺什么，suggestion 写如何补强（如联合体、补办资质、补充业绩证明等）。',
    'blockers 列出会直接导致资格不符/废标的致命缺口。readiness 为 0-100 的投标就绪度综合估计。',
    '【只输出如下 JSON】',
    '{"findings":[{"requirementId":"R1","requirement":"","category":"","mandatory":false,"coverage":"需人工确认","matched":"","gap":"","severity":"low","suggestion":"","source":""}],"summary":"","readiness":0,"blockers":[]}',
  ].join('\n');
}

export function buildCompliancePrompt(tender: TenderSpec, cap?: CapabilityProfile): string {
  return [
    '【任务】做「投标合规/废标风险自检」：基于招标文件的废标/否决条款与强制性要求，逐条核验是否存在被废标的风险，并给出整改建议。这是投标前的最后一道符合性闸门。',
    '【招标要点】',
    tenderBrief(tender),
    cap ? '【我方现状（用于判断是否满足）】' : '',
    cap ? capabilityBrief(cap) : '',
    '',
    `逐条核验招标的废标/否决条款与强制性要求。status 取值：${COMPLIANCE_STATUS.join(' / ')}；未提供我方资料而无法判断的，一律取「需人工确认」。`,
    'risk 取 low/medium/high。evidence 写判断依据/我方现状，action 写整改动作。',
    'disqualificationRisks 列出高风险废标点；passLikelihood 为 0-100 的通过初步资格/符合性审查可能性估计。',
    '【只输出如下 JSON】',
    '{"findings":[{"clause":"","status":"需人工确认","risk":"low","evidence":"","action":"","source":""}],"summary":"","disqualificationRisks":[],"passLikelihood":0}',
  ]
    .filter(Boolean)
    .join('\n');
}
