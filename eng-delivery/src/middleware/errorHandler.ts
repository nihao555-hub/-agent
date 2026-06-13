import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../errors';
import type { Logger } from '../logger';
import { formatZodError } from '../utils/validate';

/** 未匹配到任何路由时返回 404。 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { status: 404, message: `未找到路由: ${req.method} ${req.originalUrl}` },
  });
};

/** 读取框架/中间件错误上的数字 HTTP 状态（如 body-parser 解析失败会带 status=400）。 */
function numericStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  if ('status' in err && typeof err.status === 'number') return err.status;
  if ('statusCode' in err && typeof err.statusCode === 'number') return err.statusCode;
  return undefined;
}

/**
 * 统一错误处理：
 * - HttpError → 按其 status/message/details 返回
 * - ZodError → 400 + 字段级错误
 * - 其他 → 500（仅在服务端日志暴露细节，响应体不泄露堆栈）
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { status: err.status, message: err.message, details: err.details },
      });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { status: 400, message: '请求参数校验失败', details: formatZodError(err) },
      });
      return;
    }
    // body-parser 等中间件抛出的客户端错误（如 JSON 解析失败）：按其状态码返回
    const status = numericStatus(err);
    if (status !== undefined && status >= 400 && status < 500) {
      res.status(status).json({
        error: { status, message: err instanceof Error ? err.message : '请求无效' },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '未处理的服务端错误');
    res.status(500).json({ error: { status: 500, message: '服务器内部错误' } });
  };
}
