import { z } from 'zod';

/**
 * 路由层请求校验。
 * 只约束「外部 API 的输入结构」（保证后端稳定），不约束领域判断——领域判断交给大模型。
 */

const nonEmpty = z.string().trim().min(1);
const strArray = z.array(z.string().trim().min(1)).optional();

/** 我方能力档案（投标人画像），全部可选，能填多少填多少。 */
export const capabilityProfileSchema = z.object({
  companyName: z.string().trim().optional(),
  qualifications: strArray,
  pastProjects: strArray,
  team: strArray,
  finance: z.string().trim().optional(),
  techCapabilities: strArray,
  narrative: z.string().trim().optional(),
});

/** 招标要点结构（用于直接提交已结构化的 TenderSpec，或在 gap/compliance 内联传入）。 */
export const tenderSpecSchema = z.object({
  projectName: z.string().trim().optional(),
  tenderer: z.string().trim().optional(),
  agent: z.string().trim().optional(),
  method: z.string().trim().optional(),
  budget: z.string().trim().optional(),
  bidSecurity: z.string().trim().optional(),
  requirements: z
    .array(
      z.object({
        id: z.string().trim().optional(),
        category: z.string().trim().optional(),
        text: nonEmpty,
        mandatory: z.boolean().optional(),
        source: z.string().trim().optional(),
      }),
    )
    .default([]),
  scoringItems: z
    .array(
      z.object({
        name: nonEmpty,
        maxScore: z.number().min(0).max(1000).optional(),
        criteria: z.string().trim().optional(),
        category: z.string().trim().optional(),
        source: z.string().trim().optional(),
      }),
    )
    .default([]),
  disqualifications: z
    .array(
      z.object({
        text: nonEmpty,
        trigger: z.string().trim().optional(),
        source: z.string().trim().optional(),
      }),
    )
    .default([]),
  milestones: z
    .array(
      z.object({
        name: nonEmpty,
        date: z.string().trim().optional(),
        note: z.string().trim().optional(),
        source: z.string().trim().optional(),
      }),
    )
    .default([]),
  summary: z.string().trim().optional(),
});

/** 解析招标文件：提交纯文本或文件(base64)之一。 */
export const parseTenderSchema = z
  .object({
    text: z.string().trim().optional(),
    fileBase64: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
    projectName: z.string().trim().optional(),
  })
  .refine((v) => Boolean(v.text || v.fileBase64), {
    message: '请提供 text（招标文件纯文本）或 fileBase64（文件）之一',
    path: ['text'],
  });

/** 引用一份招标要点：用已持久化的 tenderId，或内联传入 tender 结构。 */
const tenderRef = z
  .object({
    tenderId: z.string().trim().optional(),
    tender: tenderSpecSchema.optional(),
  })
  .refine((v) => Boolean(v.tenderId || v.tender), {
    message: '请提供 tenderId 或内联 tender 之一',
    path: ['tenderId'],
  });

/** 引用一份我方能力：用已持久化的 capabilityId，或内联传入 capability 结构。 */
const capabilityRefRequired = z
  .object({
    capabilityId: z.string().trim().optional(),
    capability: capabilityProfileSchema.optional(),
  })
  .refine((v) => Boolean(v.capabilityId || v.capability), {
    message: '请提供 capabilityId 或内联 capability 之一',
    path: ['capabilityId'],
  });

const capabilityRefOptional = z.object({
  capabilityId: z.string().trim().optional(),
  capability: capabilityProfileSchema.optional(),
});

/** 范围缺口检测：需要招标要点 + 我方能力。 */
export const gapRequestSchema = z.intersection(tenderRef, capabilityRefRequired);

/** 合规/废标自检：需要招标要点；我方能力可选。 */
export const complianceRequestSchema = z.intersection(tenderRef, capabilityRefOptional);

/** 端到端分析：提交招标文件（文本/文件）→ 解析 + 缺口 + 合规一次完成；我方能力可选。 */
export const analyzeRequestSchema = z
  .object({
    text: z.string().trim().optional(),
    fileBase64: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
    projectName: z.string().trim().optional(),
    capabilityId: z.string().trim().optional(),
    capability: capabilityProfileSchema.optional(),
  })
  .refine((v) => Boolean(v.text || v.fileBase64), {
    message: '请提供 text 或 fileBase64 之一',
    path: ['text'],
  });

export type TenderSpecInput = z.infer<typeof tenderSpecSchema>;
export type ParseTenderBody = z.infer<typeof parseTenderSchema>;
export type GapRequestBody = z.infer<typeof gapRequestSchema>;
export type ComplianceRequestBody = z.infer<typeof complianceRequestSchema>;
export type AnalyzeRequestBody = z.infer<typeof analyzeRequestSchema>;
export type CapabilityBody = z.infer<typeof capabilityProfileSchema>;
