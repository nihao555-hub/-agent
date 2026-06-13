import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** 包装 async 路由处理器，自动把 rejected promise 转交给 Express 错误中间件。 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
