import { z } from 'zod';
import type { ResumeServiceConfig } from '../config';
import { HttpError } from '../errors';
import type { LlmClient } from '../llm/client';
import { buildResumeParsePrompt, SYSTEM_PROMPT } from '../llm/prompts';
import type { Logger } from '../logger';
import { EDUCATION_LEVELS, type ResumeProfile } from '../types';
import { highestEducationOf, normalizeEducationLevel, totalYearsOf } from '../engine/hardFilter';

export type ResumeSource = 'smartresume' | 'llm' | 'rule-based';

export interface ParseInput {
  text?: string;
  fileBase64?: string;
  fileName?: string;
}

export interface ParseOutput {
  source: ResumeSource;
  resume: ResumeProfile;
}

/** SmartResume(alibaba) pipeline 输出的宽松结构（仅取我们需要的字段）。 */
const smartResumeSchema = z.object({
  error: z.string().optional(),
  basicInfo: z
    .object({
      name: z.string().optional(),
      personalEmail: z.string().optional(),
      email: z.string().optional(),
      phoneNumber: z.string().optional(),
      phone: z.string().optional(),
      age: z.union([z.number(), z.string()]).optional(),
      gender: z.string().optional(),
      currentLocation: z.string().optional(),
      desiredLocation: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .partial()
    .optional(),
  education: z
    .array(
      z.object({
        school: z.string().optional(),
        major: z.string().optional(),
        degreeLevel: z.string().optional(),
        department: z.string().optional(),
        educationDescription: z.string().optional(),
        period: z
          .object({ startDate: z.string().optional(), endDate: z.string().optional() })
          .partial()
          .optional(),
      }),
    )
    .optional(),
  workExperience: z
    .array(
      z.object({
        companyName: z.string().optional(),
        position: z.string().optional(),
        jobDescription: z.string().optional(),
        workDescription: z.string().optional(),
        employmentPeriod: z
          .object({ startDate: z.string().optional(), endDate: z.string().optional() })
          .partial()
          .optional(),
      }),
    )
    .optional(),
  rawText: z.string().optional(),
});

type SmartResumeRaw = z.infer<typeof smartResumeSchema>;

/** LLM 文本解析输出结构。 */
const llmResumeSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  gender: z.string().optional(),
  age: z.coerce.number().int().min(0).max(120).optional(),
  currentLocation: z.string().optional(),
  desiredLocations: z.array(z.string()).default([]),
  highestEducation: z
    .string()
    .optional()
    .transform((v) => normalizeEducationLevel(v))
    .pipe(z.enum(EDUCATION_LEVELS).optional()),
  totalYears: z.coerce.number().min(0).max(60).optional(),
  skills: z.array(z.string()).default([]),
  education: z
    .array(
      z.object({
        school: z.string().optional(),
        major: z.string().optional(),
        degreeLevel: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  workExperience: z
    .array(
      z.object({
        companyName: z.string().optional(),
        position: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  selfEvaluation: z.string().optional(),
});

function s(v?: string): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** 把 SmartResume 原始输出归一化为我们的 ResumeProfile。 */
export function normalizeSmartResume(raw: SmartResumeRaw): ResumeProfile {
  const bi = raw.basicInfo ?? {};
  const age = typeof bi.age === 'string' ? Number(bi.age.replace(/[^\d]/g, '')) : bi.age;
  const desired = Array.isArray(bi.desiredLocation)
    ? bi.desiredLocation.map((d) => s(d)).filter((d): d is string => Boolean(d))
    : s(bi.desiredLocation)
      ? [s(bi.desiredLocation) as string]
      : [];
  const resume: ResumeProfile = {
    name: s(bi.name),
    phone: s(bi.phoneNumber) ?? s(bi.phone),
    email: s(bi.personalEmail) ?? s(bi.email),
    gender: s(bi.gender),
    age: Number.isFinite(age) && age ? age : undefined,
    currentLocation: s(bi.currentLocation),
    desiredLocations: desired.length ? desired : undefined,
    education: (raw.education ?? []).map((e) => ({
      school: s(e.school),
      major: s(e.major),
      degreeLevel: s(e.degreeLevel),
      startDate: s(e.period?.startDate),
      endDate: s(e.period?.endDate),
      description: s(e.educationDescription),
    })),
    workExperience: (raw.workExperience ?? []).map((w) => ({
      companyName: s(w.companyName),
      position: s(w.position),
      startDate: s(w.employmentPeriod?.startDate),
      endDate: s(w.employmentPeriod?.endDate),
      description: s(w.jobDescription) ?? s(w.workDescription),
    })),
    rawText: s(raw.rawText),
  };
  return enrich(resume);
}

/** 补全可由经历推导的字段（最高学历、累计年限）。 */
function enrich(resume: ResumeProfile): ResumeProfile {
  return {
    ...resume,
    highestEducation: resume.highestEducation ?? highestEducationOf(resume),
    totalYears: resume.totalYears ?? totalYearsOf(resume),
  };
}

/** 极简的纯文本简历兜底解析（无大模型、无外部服务时使用）。 */
export function naiveTextParse(text: string): ResumeProfile {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = text.match(/(?<!\d)(1[3-9]\d{9})(?!\d)/)?.[0];
  const name = text.match(/姓\s*名[:：]\s*([^\s,，;；\n]{2,4})/)?.[1];
  const highestEducation = normalizeEducationLevel(text);
  const resume: ResumeProfile = {
    name: s(name),
    phone: s(phone),
    email: s(email),
    highestEducation,
    education: [],
    workExperience: [],
    rawText: text,
  };
  return enrich(resume);
}

/**
 * 简历解析器：
 * - 文件（PDF/图片/Word）→ 调用 SmartResume Python 微服务（需配置 RESUME_SERVICE_URL）。
 * - 纯文本 → 优先大模型解析，失败回退极简正则解析。
 */
export class ResumeParser {
  constructor(
    private readonly config: ResumeServiceConfig,
    private readonly llm?: LlmClient,
    private readonly logger?: Logger,
  ) {}

  async parse(input: ParseInput): Promise<ParseOutput> {
    if (input.fileBase64) {
      const resume = await this.parseFile(input.fileBase64, input.fileName ?? 'resume.pdf');
      return { source: 'smartresume', resume };
    }
    if (input.text) return this.parseText(input.text);
    throw new HttpError(400, '请提供 text 或 fileBase64');
  }

  private async parseFile(fileBase64: string, fileName: string): Promise<ResumeProfile> {
    if (!this.config.url) {
      throw new HttpError(
        503,
        '未配置简历解析服务（RESUME_SERVICE_URL），无法解析文件。请先部署 resume-service，或改用 text 字段提交纯文本简历。',
      );
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileBase64, 'base64');
    } catch {
      throw new HttpError(400, 'fileBase64 不是合法的 base64 字符串');
    }
    const form = new FormData();
    form.append('file', new Blob([buffer]), fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(`${this.config.url}/parse`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`简历解析服务返回 ${resp.status}`);
      const raw = smartResumeSchema.parse(await resp.json());
      if (raw.error) throw new Error(`简历解析失败：${raw.error}`);
      return normalizeSmartResume(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: msg }, '调用简历解析服务失败');
      throw new HttpError(502, `简历解析服务不可用：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseText(text: string): Promise<ParseOutput> {
    if (this.llm) {
      try {
        const data = await this.llm.chatJson({
          system: SYSTEM_PROMPT,
          user: buildResumeParsePrompt(text),
          schema: llmResumeSchema,
        });
        const resume: ResumeProfile = enrich({
          name: data.name,
          phone: data.phone,
          email: data.email,
          gender: data.gender,
          age: data.age,
          currentLocation: data.currentLocation,
          desiredLocations: data.desiredLocations.length ? data.desiredLocations : undefined,
          highestEducation: data.highestEducation,
          totalYears: data.totalYears,
          skills: data.skills.length ? data.skills : undefined,
          education: data.education,
          workExperience: data.workExperience,
          selfEvaluation: data.selfEvaluation,
          rawText: text,
        });
        return { source: 'llm', resume };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err: msg }, '大模型解析简历失败，回退正则解析');
      }
    }
    return { source: 'rule-based', resume: naiveTextParse(text) };
  }
}
