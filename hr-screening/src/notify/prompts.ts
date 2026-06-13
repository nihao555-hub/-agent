import type { JobPosting, ResumeProfile } from '../types';
import { STATUS_LABELS, type ApplicationStatus } from '../pipeline/status';

/** 状态对应的反馈意图说明（喂给大模型，约束文案目的与边界）。 */
const STATUS_INTENT: Partial<Record<ApplicationStatus, string>> = {
  screening: '告知候选人简历已通过初步筛选、进入初筛环节，请其耐心等待后续沟通。',
  interview:
    '邀请候选人参加面试，语气积极、专业；请其回复方便的面试时间（可选线上/线下），并说明后续会有专人对接具体安排。',
  rejected:
    '礼貌、有温度地告知候选人本次未能进入下一轮。务必：感谢投递、肯定其时间与意愿、鼓励未来再合作；不得给出任何带有歧视性或贬损性的理由（不得提及年龄/性别/籍贯/婚育/院校出身等与岗位无关因素），可笼统说明「综合匹配度」；不承诺任何未发生的结果。',
  talent_pool: '告知候选人其背景已纳入企业人才库，未来有更合适的岗位会优先联系，感谢其投递。',
};

export function buildFeedbackSystemPrompt(): string {
  return [
    '你是一位资深、专业且富有同理心的招聘沟通专家，负责为候选人撰写应聘进展通知。',
    '要求：',
    '1) 语气专业、真诚、有温度，简洁得体（中文，正文 120-260 字）。',
    '2) 严禁任何歧视性或贬损性表述，不得提及年龄、性别、籍贯、户籍、婚育、健康、宗教、政治、院校出身等与岗位无关的因素。',
    '3) 不夸大、不承诺任何未发生的结果（如不得暗示一定会被录用）。',
    '4) 不索取证件号、银行卡等敏感信息。',
    '5) 拒信要保护候选人自尊，鼓励其未来继续关注。',
    '只输出 JSON：{"subject": "邮件/通知标题", "body": "通知正文"}，不要输出多余文字。',
  ].join('\n');
}

export function buildFeedbackUserPrompt(input: {
  job: JobPosting;
  resume: ResumeProfile;
  status: ApplicationStatus;
  reason?: string;
}): string {
  const { job, resume, status } = input;
  const name = resume.name ?? '候选人';
  const company = job.company ?? '我司';
  const intent =
    STATUS_INTENT[status] ?? `告知候选人其应聘状态更新为「${STATUS_LABELS[status]}」。`;
  const lines = [
    `候选人称呼：${name}`,
    `应聘岗位：${job.title}`,
    `招聘方：${company}`,
    `本次通知对应的状态：${STATUS_LABELS[status]}`,
    `本次通知的目的：${intent}`,
  ];
  if (input.reason) {
    lines.push(`内部备注（仅供你把握分寸，不要原样写进对外正文）：${input.reason}`);
  }
  lines.push('请据此撰写得体的对外通知文案，并以 JSON 返回 {subject, body}。');
  return lines.join('\n');
}
