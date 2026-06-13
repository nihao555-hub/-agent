import type { BimServiceConfig } from '../config';
import { HttpError } from '../errors';
import type { StructuredBlock } from '../doc/chunker';
import type { Logger } from '../logger';

/** 空间（IfcSpace）：房间/区域及其面积体积。 */
export interface BimSpace {
  id?: string;
  name?: string;
  longName?: string;
  area?: number;
  volume?: number;
}

/** 构件（IfcWall/IfcSlab/...）及其材料、楼层、工程量。 */
export interface BimElement {
  id?: string;
  type?: string;
  name?: string;
  material?: string;
  storey?: string;
  quantities?: Record<string, number>;
}

/** 汇总工程量行（可直接对账 BOQ）。 */
export interface BimQuantity {
  name: string;
  value: number;
  unit?: string;
}

export interface BimModel {
  project?: string;
  schema?: string;
  spaces?: BimSpace[];
  elements?: BimElement[];
  quantities?: BimQuantity[];
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function fmtQuantities(q: Record<string, number>): string {
  return Object.entries(q)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/**
 * 把 BIM 模型摊平成「可被检索/引用的工程量事实块」。纯函数，便于离线测试。
 * 每个空间/构件/汇总量各成一块，措辞中文化，便于和合同/BOQ 做语义对账。
 */
export function summarizeBimModel(model: BimModel): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  for (const s of model.spaces ?? []) {
    const parts = ['空间', s.longName ?? s.name ?? s.id ?? '(未命名)'];
    if (s.area != null) parts.push(`面积 ${s.area}㎡`);
    if (s.volume != null) parts.push(`体积 ${s.volume}m³`);
    blocks.push({ text: parts.join(' '), clause: s.id });
  }
  for (const e of model.elements ?? []) {
    const parts = ['构件', e.type ?? '(未知类型)', e.name ?? e.id ?? ''];
    if (e.material) parts.push(`材料 ${e.material}`);
    if (e.storey) parts.push(`楼层 ${e.storey}`);
    if (e.quantities && Object.keys(e.quantities).length > 0) {
      parts.push(`工程量 ${fmtQuantities(e.quantities)}`);
    }
    blocks.push({ text: parts.filter(Boolean).join(' '), clause: e.id });
  }
  for (const q of model.quantities ?? []) {
    blocks.push({ text: `汇总工程量 ${q.name}: ${q.value}${q.unit ? ` ${q.unit}` : ''}` });
  }
  return blocks;
}

/** 把宽松 JSON 归一化为 BimModel。纯函数。 */
export function normalizeBimPayload(payload: unknown): BimModel {
  if (!isRecord(payload)) return {};
  const spaces = Array.isArray(payload.spaces)
    ? payload.spaces.filter(isRecord).map((s) => ({
        id: str(s.id),
        name: str(s.name),
        longName: str(s.longName) ?? str(s.long_name),
        area: num(s.area),
        volume: num(s.volume),
      }))
    : undefined;
  const elements = Array.isArray(payload.elements)
    ? payload.elements.filter(isRecord).map((e) => {
        const rawQ = isRecord(e.quantities) ? e.quantities : undefined;
        const quantities: Record<string, number> = {};
        if (rawQ) {
          for (const [k, v] of Object.entries(rawQ)) {
            const n = num(v);
            if (n != null) quantities[k] = n;
          }
        }
        return {
          id: str(e.id),
          type: str(e.type) ?? str(e.ifc_type),
          name: str(e.name),
          material: str(e.material),
          storey: str(e.storey) ?? str(e.level),
          quantities: Object.keys(quantities).length > 0 ? quantities : undefined,
        };
      })
    : undefined;
  const quantities = Array.isArray(payload.quantities)
    ? payload.quantities
        .filter(isRecord)
        .map((q) => ({ name: str(q.name) ?? '', value: num(q.value) ?? 0, unit: str(q.unit) }))
        .filter((q) => q.name)
    : undefined;
  return { project: str(payload.project), schema: str(payload.schema), spaces, elements, quantities };
}

/**
 * BIM 理解：把 IFC 模型解析成空间/构件/工程量事实（layer C）。
 * 走 IfcOpenShell 风格微服务（需配 BIM_SERVICE_URL）；未配置时给出明确 503。
 */
export class BimAnalyzer {
  constructor(
    private readonly config: BimServiceConfig,
    private readonly logger?: Logger,
  ) {}

  async analyze(fileBase64: string, fileName = 'model.ifc'): Promise<BimModel> {
    if (!this.config.url) {
      throw new HttpError(
        503,
        '未配置 BIM 解析服务（BIM_SERVICE_URL），无法解析 IFC 模型。请先部署 IfcOpenShell 风格微服务。',
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
      const resp = await fetch(`${this.config.url}/ifc`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`BIM 解析服务返回 ${resp.status}`);
      const json: unknown = await resp.json();
      if (isRecord(json) && str(json.error)) throw new Error(`BIM 解析失败：${String(json.error)}`);
      return normalizeBimPayload(json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: msg }, '调用 BIM 解析服务失败');
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `BIM 解析服务不可用：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
