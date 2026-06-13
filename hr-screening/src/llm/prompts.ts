import {
  BG_CATEGORIES,
  EDUCATION_LEVELS,
  OUTREACH_CHANNELS,
  RISK_TYPES,
  SCORE_DIMENSIONS,
  type AuthorizedFinding,
  type HardFilterResult,
  type JobPosting,
  type OutreachChannel,
  type ResumeProfile,
} from '../types';

export const SYSTEM_PROMPT = [
  '你是一名资深、严谨、负责任的招聘初筛助手，服务于中国大陆的 HR / 招聘专员。',
  '硬性纪律：',
  '1) 只输出 JSON，不要任何解释、前后缀或 markdown 代码块；',
  '2) 使用简体中文；严格按给定字段名输出，数组顺序与数量遵循要求；',
  '3) 严禁编造简历或材料中不存在的信息；信息不足时如实标注「未提供」「未核实」，不得臆测候选人隐私；',
  '4) 反歧视：不得因性别、年龄、籍贯、户籍、民族、婚育、外貌、院校出身、健康等与岗位无关的因素影响评分或结论，只评估与岗位相关的能力、经历与匹配度；',
  '5) 评分与结论要给出可追溯的理由，基于简历中的客观事实。',
].join('\n');

export function buildParseJobPrompt(input: {
  description: string;
  title?: string;
  company?: string;
  city?: string;
}): string {
  return [
    '【任务】把下面这段招聘需求（JD）抽取成结构化字段。',
    input.title ? `已知岗位名称：${input.title}` : '',
    input.company ? `已知公司：${input.company}` : '',
    input.city ? `已知城市：${input.city}` : '',
    '【JD 原文】',
    input.description,
    '',
    `minEducation 只能取以下之一或省略：${EDUCATION_LEVELS.join(' / ')}。`,
    'minYears 为最低工作年限（数字，单位年）。requiredSkills 为硬性必备技能，preferredSkills 为加分技能。',
    '若 JD 未提及某字段则省略该字段，不要编造。',
    '【只输出如下 JSON】',
    '{"title":"","company":"","city":"","minEducation":"","minYears":0,"requiredSkills":[],"preferredSkills":[],"responsibilities":[],"locations":[],"salaryRange":"","headcount":0}',
  ]
    .filter(Boolean)
    .join('\n');
}

function resumeBrief(resume: ResumeProfile): string {
  const edu = resume.education
    .map((e) =>
      `${e.school ?? ''} ${e.major ?? ''} ${e.degreeLevel ?? ''} ${e.startDate ?? ''}~${e.endDate ?? ''}`.trim(),
    )
    .join('；');
  const work = resume.workExperience
    .map((w) =>
      `${w.companyName ?? ''} ${w.position ?? ''} ${w.startDate ?? ''}~${w.endDate ?? ''} ${w.description ?? ''}`.trim(),
    )
    .join('\n');
  return [
    `姓名：${resume.name ?? '未提供'}`,
    resume.highestEducation ? `最高学历：${resume.highestEducation}` : '',
    typeof resume.totalYears === 'number' ? `工作年限：${resume.totalYears}` : '',
    resume.currentLocation ? `现居：${resume.currentLocation}` : '',
    resume.desiredLocations?.length ? `期望地点：${resume.desiredLocations.join('、')}` : '',
    resume.skills?.length ? `技能：${resume.skills.join('、')}` : '',
    edu ? `教育经历：${edu}` : '',
    work ? `工作经历：\n${work}` : '',
    resume.selfEvaluation ? `自我评价：${resume.selfEvaluation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function jobBrief(job: JobPosting): string {
  return [
    `岗位：${job.title}`,
    job.company ? `公司：${job.company}` : '',
    job.city ? `城市：${job.city}` : '',
    job.minEducation ? `最低学历：${job.minEducation}` : '',
    typeof job.minYears === 'number' ? `最低年限：${job.minYears}` : '',
    job.requiredSkills?.length ? `必备技能：${job.requiredSkills.join('、')}` : '',
    job.preferredSkills?.length ? `加分技能：${job.preferredSkills.join('、')}` : '',
    job.responsibilities?.length ? `岗位职责：${job.responsibilities.join('；')}` : '',
    job.description ? `JD：${job.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildResumeParsePrompt(text: string): string {
  return [
    '【任务】把下面这段简历纯文本解析成结构化字段，只提取文本中确实存在的信息，缺失字段一律省略，严禁编造。',
    '【简历文本】',
    text,
    '',
    `highestEducation 只能取以下之一或省略：${EDUCATION_LEVELS.join(' / ')}。`,
    'age/totalYears 为数字。education 为教育经历数组，workExperience 为工作经历数组。日期尽量保留原文（如 2020.03）。',
    'skills 为技能/关键词数组。desiredLocations 为期望工作地点数组。',
    '【只输出如下 JSON】',
    '{"name":"","phone":"","email":"","gender":"","age":0,"currentLocation":"","desiredLocations":[],"highestEducation":"","totalYears":0,"skills":[],"education":[{"school":"","major":"","degreeLevel":"","startDate":"","endDate":"","description":""}],"workExperience":[{"companyName":"","position":"","startDate":"","endDate":"","description":""}],"selfEvaluation":""}',
  ].join('\n');
}

export function buildScorePrompt(
  job: JobPosting,
  resume: ResumeProfile,
  hardFilter: HardFilterResult,
): string {
  const hf = hardFilter.checks
    .map((c) => `- ${c.label}：${c.passed ? '通过' : '不通过'}（${c.detail}）`)
    .join('\n');
  return [
    '【任务】基于岗位要求评估这份简历，做「软筛」打分（硬性条件已由系统判定，见下方，无需重复判断，但可在结论中参考）。',
    '【岗位】',
    jobBrief(job),
    '【候选人简历】',
    resumeBrief(resume),
    '【系统已判定的硬性条件】',
    hf || '（无显式硬性条件）',
    '',
    `dimensions 必须且仅包含这 ${SCORE_DIMENSIONS.length} 个维度，顺序固定：${SCORE_DIMENSIONS.join('、')}；每个 score 为 0-100 整数。`,
    `matchScore 为 0-100 的综合匹配分。recommendation 取值：advance(推进约面)/hold(进人才库待定)/reject(淘汰)。`,
    `risks[].type 只能取：${RISK_TYPES.join(' / ')}；severity 取 low/medium/high。`,
    'highlights 为亮点，suggestedQuestions 为电话/面试初筛建议追问的问题（结合风险点与缺口）。',
    '严禁因与岗位无关的个人因素影响评分。基于简历客观事实给理由。',
    '【只输出如下 JSON】',
    '{"matchScore":0,"dimensions":[{"dimension":"岗位匹配","score":0,"reason":""}],"highlights":[],"risks":[{"type":"信息缺失","severity":"low","detail":""}],"recommendation":"hold","reason":"","suggestedQuestions":[]}',
  ].join('\n');
}

export function buildOutreachPrompt(
  job: JobPosting,
  resume: ResumeProfile,
  channel: OutreachChannel,
): string {
  return [
    `【任务】为「初步触达」写一段${channel}沟通话术，用于电话初筛/邀约。`,
    `channel 固定为：${channel}（可选值：${OUTREACH_CHANNELS.join('/')}）。`,
    '【岗位】',
    jobBrief(job),
    '【候选人】',
    resumeBrief(resume),
    '',
    'message 为可直接使用的话术（口吻自然、专业、简短）；screeningQuestions 为触达时要确认的关键问题（到岗时间、薪资期望、离职原因、关键经历真伪等）。',
    '不要索取与岗位无关的隐私信息。',
    '【只输出如下 JSON】',
    `{"channel":"${channel}","message":"","screeningQuestions":[]}`,
  ].join('\n');
}

export function buildProfilePrompt(
  resume: ResumeProfile,
  findings: AuthorizedFinding[],
  osintLeads: string[] = [],
): string {
  const f = findings
    .map((x, i) => `${i + 1}. [${x.category}] 来源：${x.source}；结论：${x.result}`)
    .join('\n');
  const osint = osintLeads.length
    ? [
        '【公开足迹线索（OSINT 收集，仅供参考，归属未经核实）】',
        ...osintLeads.map((l, i) => `${i + 1}. ${l}`),
        '注意：以上为按候选人提供标识收集到的公开账号线索，未经人工核实归属，只能作为「待核实」线索，严禁据此对候选人下结论。',
      ].join('\n')
    : '';
  return [
    '【任务】基于「候选人已书面授权」后通过合法渠道取得的核验信息，整合一份背调画像。',
    '【合规约束】只能使用下面提供的「已授权核验信息」与简历内容，严禁编造、严禁引入任何未提供的个人隐私信息；信息不足处一律标注「未核实」。',
    '【候选人简历摘要】',
    resumeBrief(resume),
    '【已授权核验信息】',
    f,
    osint,
    '',
    `verifiedItems[].category 取值：${BG_CATEGORIES.join(' / ')}；status 取值：已核实 / 存疑 / 未核实。`,
    'riskLevel 取 low/medium/high。strengths 为可信优势，concerns 为需关注/待澄清事项。',
    'recommendation 为给 HR 的决策建议（是否可推进 offer、需补充核实什么）。',
    '【只输出如下 JSON】',
    '{"summary":"","strengths":[],"concerns":[],"verifiedItems":[{"category":"学历核验","status":"已核实","detail":""}],"riskLevel":"low","recommendation":""}',
  ].join('\n');
}
