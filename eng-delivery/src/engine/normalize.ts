import type { TenderRequirement } from '../types';

/**
 * 给要求列表补齐稳定编号（R1、R2…）。
 * 已有合法 id 的保留；缺失或重复的按出现顺序重排，保证缺口/合规结果能稳定引用。
 */
export function assignRequirementIds(
  items: Array<Omit<TenderRequirement, 'id'> & { id?: string }>,
): TenderRequirement[] {
  const seen = new Set<string>();
  return items.map((item, idx) => {
    let id = item.id?.trim();
    if (!id || seen.has(id)) {
      id = `R${idx + 1}`;
    }
    seen.add(id);
    return {
      id,
      category: item.category || '未分类',
      text: item.text,
      mandatory: item.mandatory,
      source: item.source,
    };
  });
}
