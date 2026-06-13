import { RISK_TYPES, type JobPosting, type ResumeProfile } from '../types';
import type { ChatMessage } from './types';

function jobBrief(job: JobPosting): string {
  return [
    `岗位：${job.title}`,
    job.company ? `公司：${job.company}` : '',
    job.city ? `城市：${job.city}` : '',
    job.minEducation ? `最低学历：${job.minEducation}` : '',
    typeof job.minYears === 'number' ? `最低年限：${job.minYears} 年` : '',
    job.requiredSkills?.length ? `必备技能：${job.requiredSkills.join('、')}` : '',
    job.preferredSkills?.length ? `加分技能：${job.preferredSkills.join('、')}` : '',
    job.responsibilities?.length ? `岗位职责：${job.responsibilities.join('；')}` : '',
    job.salaryRange ? `薪资范围：${job.salaryRange}` : '',
    job.description ? `JD：${job.description}` : '',
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
    typeof resume.totalYears === 'number' ? `工作年限：${resume.totalYears} 年` : '',
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

/**
 * 对话式初筛的系统提示词：把 AI 设定为「顶级 HR 专家」，并注入岗位 JD 与候选人简历画像。
 * 强约束：合规、反歧视、一次一问、不承诺结果、不索取无关隐私。
 */
export function buildChatSystemPrompt(job: JobPosting, resume: ResumeProfile): string {
  return [
    '你是一名资深、专业的招聘官（顶级 HR 专家，具备资深猎头与招聘负责人的水准），正在对一位候选人进行「初筛沟通」（相当于电话初筛 / 微信初聊）。',
    '你的目标：在友好、专业、简洁的对话中，确认候选人的求职意向与关键信息真实性，评估其与目标岗位的匹配度，并识别风险点（如跳槽频繁、空窗期、经历存疑等）。',
    '',
    '对话纪律：',
    '1) 全程使用简体中文，口吻自然、礼貌、专业，像真实的 HR，不要像机器人或念稿，不要使用 markdown 或列表符号；',
    '2) 一次只问一个最关键的问题，循序渐进；要紧扣候选人上一句话自然追问，不要一次抛出一长串问题；',
    '3) 优先确认这些要点：当前求职状态与到岗时间、期望薪资、与本岗位最相关的一段经历及其真实细节、简历中的疑点（空窗/频繁跳槽/经历夸大）、对工作地点与出差加班等硬性条件的接受度；',
    '4) 严禁询问与岗位无关的隐私（婚育与生育计划、家庭情况、宗教信仰、政治倾向、健康状况、籍贯户籍等），也不得做出或暗示任何基于性别、年龄、籍贯、婚育、院校出身的歧视性判断；',
    '5) 不承诺录用或面试结果，不透露其他候选人信息，不索取身份证号、银行卡等敏感个人信息；',
    '6) 当关键信息已基本确认，或候选人明确希望结束时，请礼貌收尾，并说明后续会通过正式渠道反馈结果。',
    '',
    '【目标岗位】',
    jobBrief(job),
    '',
    '【候选人简历摘要】',
    resumeBrief(resume),
  ].join('\n');
}

/** 开场白指令：让模型作为 HR 主动开启这次初筛对话。 */
export const OPENING_INSTRUCTION =
  '（系统指令）请你作为招聘官开启这次初筛对话：先简短自我介绍并确认候选人现在是否方便沟通，然后自然地问出第一个最关键的问题。只输出你要对候选人说的话，不要任何旁白或解释。';

/** 把持久化的消息历史映射为 LLM 对话消息（candidate→user，assistant→assistant）。 */
export function toLlmHistory(
  messages: ChatMessage[],
): { role: 'user' | 'assistant'; content: string }[] {
  return messages.map((m) => ({
    role: m.role === 'candidate' ? 'user' : 'assistant',
    content: m.content,
  }));
}

/** 渲染对话记录为纯文本，用于小结提示词。 */
function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'candidate' ? '候选人' : 'HR'}：${m.content}`)
    .join('\n');
}

/** 小结提示词：基于岗位、简历与完整对话记录，产出结构化初筛小结（仅输出 JSON）。 */
export function buildSummaryPrompt(
  job: JobPosting,
  resume: ResumeProfile,
  messages: ChatMessage[],
): string {
  return [
    '【任务】你是资深招聘官，请基于下面的目标岗位、候选人简历摘要与完整初筛对话记录，产出一份结构化的初筛小结。',
    '【合规约束】只能依据对话与简历中的客观事实，严禁编造未出现的信息；信息不足处如实写入 pendingInfo（待确认）。严禁因性别、年龄、籍贯、婚育、院校出身等与岗位无关的因素影响结论。',
    '【目标岗位】',
    jobBrief(job),
    '【候选人简历摘要】',
    resumeBrief(resume),
    '【初筛对话记录】',
    transcript(messages) || '（暂无对话内容）',
    '',
    'confirmedInfo 为对话中已确认的信息（如到岗时间、期望薪资、关键经历等），pendingInfo 为仍待确认/未澄清的信息。',
    `risks[].type 只能取：${RISK_TYPES.join(' / ')}；severity 取 low/medium/high。`,
    'recommendation 取值：advance(推进约面)/hold(进人才库待定)/reject(淘汰)。fitAssessment 为与岗位匹配度的总体判断，reason 给出结论理由，nextQuestions 为若继续沟通建议追问的问题。',
    '【只输出如下 JSON，不要任何解释或代码块】',
    '{"fitAssessment":"","confirmedInfo":[],"pendingInfo":[],"risks":[{"type":"信息缺失","severity":"low","detail":""}],"recommendation":"hold","reason":"","nextQuestions":[]}',
  ].join('\n');
}
