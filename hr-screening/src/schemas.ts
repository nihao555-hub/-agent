import { z } from 'zod';
import { OSINT_TOOLS } from './osint/collector';
import { BG_CATEGORIES, EDUCATION_LEVELS, OUTREACH_CHANNELS } from './types';

const consentTrue = z.literal(true, {
  errorMap: () => ({ message: '必须确认已取得候选人书面授权（consentObtained=true）' }),
});

export const osintAccountSchema = z.object({
  tool: z.enum(OSINT_TOOLS),
  site: z.string().min(1),
  url: z.string().min(1),
  category: z.string().optional(),
});

export const osintCollectRequestSchema = z.object({
  consentObtained: consentTrue,
  handles: z
    .object({
      usernames: z.array(z.string().min(1)).max(20).optional(),
      emails: z.array(z.string().min(1)).max(20).optional(),
      phones: z.array(z.string().min(1)).max(20).optional(),
      domains: z.array(z.string().min(1)).max(20).optional(),
    })
    .refine(
      (h) =>
        Boolean(h.usernames?.length || h.emails?.length || h.phones?.length || h.domains?.length),
      { message: '请至少提供一个候选人标识（usernames/emails/phones/domains）' },
    ),
});

export const jobPostingSchema = z.object({
  title: z.string().min(1, '岗位名称不能为空'),
  company: z.string().optional(),
  city: z.string().optional(),
  description: z.string().max(20000).optional(),
  responsibilities: z.array(z.string()).max(50).optional(),
  minEducation: z.enum(EDUCATION_LEVELS).optional(),
  minYears: z.number().min(0).max(50).optional(),
  requiredSkills: z.array(z.string()).max(50).optional(),
  preferredSkills: z.array(z.string()).max(50).optional(),
  locations: z.array(z.string()).max(20).optional(),
  salaryRange: z.string().optional(),
  headcount: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});

const educationItemSchema = z.object({
  school: z.string().optional(),
  major: z.string().optional(),
  degreeLevel: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  description: z.string().optional(),
});

const workItemSchema = z.object({
  companyName: z.string().optional(),
  position: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  description: z.string().optional(),
});

export const resumeProfileSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  gender: z.string().optional(),
  age: z.number().int().min(0).max(120).optional(),
  currentLocation: z.string().optional(),
  desiredLocations: z.array(z.string()).max(20).optional(),
  highestEducation: z.enum(EDUCATION_LEVELS).optional(),
  totalYears: z.number().min(0).max(60).optional(),
  skills: z.array(z.string()).max(100).optional(),
  education: z.array(educationItemSchema).max(20).default([]),
  workExperience: z.array(workItemSchema).max(30).default([]),
  selfEvaluation: z.string().max(5000).optional(),
  rawText: z.string().max(50000).optional(),
});

export const parseJobRequestSchema = z.object({
  description: z.string().min(1, 'JD 描述不能为空').max(20000),
  title: z.string().optional(),
  company: z.string().optional(),
  city: z.string().optional(),
});

export const parseResumeRequestSchema = z
  .object({
    text: z.string().min(1).max(50000).optional(),
    fileBase64: z.string().min(1).optional(),
    fileName: z.string().max(255).optional(),
  })
  .refine((v) => Boolean(v.text) || Boolean(v.fileBase64), {
    message: '请提供 text（纯文本简历）或 fileBase64（PDF/图片/Word 文件）之一',
  });

export const scoreRequestSchema = z.object({
  job: jobPostingSchema,
  resume: resumeProfileSchema,
});

export const batchScoreRequestSchema = z.object({
  job: jobPostingSchema,
  candidates: z.array(resumeProfileSchema).min(1, '至少需要一份简历').max(50),
});

export const outreachRequestSchema = z.object({
  job: jobPostingSchema,
  resume: resumeProfileSchema,
  channel: z.enum(OUTREACH_CHANNELS).optional(),
});

export const backgroundPlanRequestSchema = z.object({
  resume: resumeProfileSchema,
  job: jobPostingSchema.optional(),
  /** 候选人是否已书面授权背调；默认 false（未授权则只返回授权指引，不产出核验计划） */
  consentObtained: z.boolean().default(false),
});

const authorizedFindingSchema = z.object({
  category: z.enum(BG_CATEGORIES),
  source: z.string().min(1),
  result: z.string().min(1),
});

export const backgroundProfileRequestSchema = z.object({
  resume: resumeProfileSchema,
  /** 已通过合法渠道取得授权后回填的核验结论；画像只基于这些信息整合 */
  findings: z.array(authorizedFindingSchema).min(1, '至少需要一条已授权的核验结论').max(50),
  /** 由 /api/background-check/osint 收集到的公开账号线索（可选，仅作待核实参考） */
  osintAccounts: z.array(osintAccountSchema).max(200).optional(),
  consentObtained: consentTrue,
});

export const analyzeRequestSchema = z.object({
  job: jobPostingSchema,
  resume: resumeProfileSchema,
  channel: z.enum(OUTREACH_CHANNELS).optional(),
  consentObtained: z.boolean().default(false),
  findings: z.array(authorizedFindingSchema).max(50).optional(),
});
