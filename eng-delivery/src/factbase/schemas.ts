import { z } from 'zod';
import { DOCUMENT_TYPES, IN_SCOPE, PROJECT_STATUS } from './types';

const nonEmpty = z.string().trim().min(1, '不能为空');
const optional = z
  .string()
  .trim()
  .min(1)
  .optional();

export const createProjectSchema = z.object({
  name: nonEmpty,
  status: z.enum(PROJECT_STATUS).optional(),
  tenderer: optional,
  client: optional,
});

export const setStatusSchema = z.object({
  status: z.enum(PROJECT_STATUS),
});

export const ingestDocumentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    title: optional,
    source: optional,
    text: z.string().optional(),
    fileBase64: z.string().optional(),
    fileName: optional,
  })
  .refine((v) => (v.text && v.text.trim().length > 0) || (v.fileBase64 && v.fileBase64.length > 0), {
    message: '请提供 text（文档纯文本）或 fileBase64（PDF/Word 文件）之一',
    path: ['text'],
  });

export const extractScopeSchema = z.object({
  documentId: optional,
});

export const recordChangeSchema = z.object({
  title: nonEmpty,
  description: optional,
  inScope: z.enum(IN_SCOPE).optional(),
  basisChunkId: optional,
  costImpact: optional,
  timeImpact: optional,
});

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type SetStatusBody = z.infer<typeof setStatusSchema>;
export type IngestDocumentBody = z.infer<typeof ingestDocumentSchema>;
export type ExtractScopeBody = z.infer<typeof extractScopeSchema>;
export type RecordChangeBody = z.infer<typeof recordChangeSchema>;
