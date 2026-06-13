import { type TypeOf, type ZodError, type ZodType } from 'zod';
import { HttpError } from '../errors';

export interface FieldIssue {
  /** 出错字段路径，如 "shop.name" */
  path: string;
  message: string;
}

/** 把 ZodError 拍平成对前端友好的字段级错误列表。 */
export function formatZodError(err: ZodError): FieldIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/**
 * 用 zod schema 校验请求体；失败时抛出 400 HttpError（含字段级 details），
 * 成功时返回带有完整类型推断的结果，供路由直接传给引擎。
 */
export function parseBody<S extends ZodType>(schema: S, body: unknown): TypeOf<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, '请求参数校验失败', formatZodError(result.error));
  }
  return result.data;
}
