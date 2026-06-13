import OpenAI from 'openai';
import type { TypeOf, ZodType } from 'zod';
import type { Logger } from '../logger';

export interface LlmClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  logger?: Logger;
}

export interface ChatJsonParams<S extends ZodType> {
  system: string;
  user: string;
  schema: S;
  temperature?: number;
}

/** 可重试的瞬时错误特征（grsai 代理在高频/限流时会返回 apikey error 等） */
const TRANSIENT =
  /apikey error|rate|limit|timeout|timed out|temporar|overload|busy|too many|empty|503|429|500|502|504/i;

interface ProxyErrorBody {
  error?: { message?: string; type?: string };
}

/** 从模型文本中稳健地抽取 JSON：去除 ``` 代码围栏，必要时截取首个 {..} / [..] 块。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    // 继续尝试截取 JSON 片段
  }
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('LLM 响应中未找到 JSON');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error('LLM 响应中的 JSON 不完整');
  return JSON.parse(body.slice(start, end + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LlmClient {
  private readonly client: OpenAI;
  readonly model: string;
  private readonly maxRetries: number;
  private readonly logger?: Logger;

  constructor(opts: LlmClientOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs,
      // 自行重试：代理常以 HTTP 200 + {"error":...} 形式返回瞬时错误，SDK 内置重试无法覆盖。
      maxRetries: 0,
    });
    this.model = opts.model;
    this.maxRetries = opts.maxRetries;
    this.logger = opts.logger;
  }

  async chatJson<S extends ZodType>(params: ChatJsonParams<S>): Promise<TypeOf<S>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      try {
        const resp = await this.client.chat.completions.create({
          model: this.model,
          temperature: params.temperature ?? 0.7,
          messages: [
            { role: 'system', content: params.system },
            { role: 'user', content: params.user },
          ],
        });
        const errBody = (resp as unknown as ProxyErrorBody).error;
        if (errBody)
          throw new Error(`LLM 返回错误: ${errBody.message ?? errBody.type ?? 'unknown'}`);
        const content = resp.choices?.[0]?.message?.content;
        if (!content || !content.trim()) throw new Error('LLM 返回内容为空');
        return params.schema.parse(extractJson(content));
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ attempt, model: this.model, err: msg }, 'LLM 调用失败');
        if (!TRANSIENT.test(msg) && attempt >= 1) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
