import { describe, expect, it } from 'vitest';
import { BimAnalyzer, normalizeBimPayload, summarizeBimModel } from '../src/bim/client';

describe('summarizeBimModel BIM 模型摊平为事实块（纯函数）', () => {
  it('空间/构件/汇总工程量各成一块，措辞含关键量', () => {
    const blocks = summarizeBimModel({
      spaces: [{ id: 'S1', longName: '一层泵房', area: 120, volume: 480 }],
      elements: [
        { id: 'W1', type: 'IfcWall', material: 'C30混凝土', storey: 'F1', quantities: { volume: 35 } },
      ],
      quantities: [{ name: '混凝土总量', value: 1200, unit: 'm³' }],
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toContain('一层泵房');
    expect(blocks[0].text).toContain('120');
    expect(blocks[0].clause).toBe('S1');
    expect(blocks[1].text).toContain('IfcWall');
    expect(blocks[1].text).toContain('C30混凝土');
    expect(blocks[1].text).toContain('volume=35');
    expect(blocks[2].text).toContain('混凝土总量');
    expect(blocks[2].text).toContain('1200');
  });

  it('空模型返回空数组', () => {
    expect(summarizeBimModel({})).toEqual([]);
  });
});

describe('normalizeBimPayload 宽松 JSON 归一化（纯函数）', () => {
  it('兼容 long_name/ifc_type/level 等别名与字符串数字', () => {
    const model = normalizeBimPayload({
      project: 'P',
      spaces: [{ id: 'S1', long_name: '泵房', area: '120' }],
      elements: [{ id: 'W1', ifc_type: 'IfcWall', level: 'F1', quantities: { volume: '35', bad: 'x' } }],
      quantities: [{ name: '钢筋', value: '8.5', unit: 't' }, { name: '', value: 1 }],
    });
    expect(model.spaces?.[0]).toMatchObject({ longName: '泵房', area: 120 });
    expect(model.elements?.[0]).toMatchObject({ type: 'IfcWall', storey: 'F1' });
    expect(model.elements?.[0].quantities).toEqual({ volume: 35 });
    // 空名汇总量被过滤
    expect(model.quantities).toHaveLength(1);
    expect(model.quantities?.[0]).toMatchObject({ name: '钢筋', value: 8.5, unit: 't' });
  });

  it('非对象输入返回空模型', () => {
    expect(normalizeBimPayload(null)).toEqual({});
  });
});

describe('BimAnalyzer', () => {
  it('未配 BIM_SERVICE_URL → 503', async () => {
    const analyzer = new BimAnalyzer({ timeoutMs: 1000 });
    await expect(analyzer.analyze('AAAA', 'm.ifc')).rejects.toMatchObject({ status: 503 });
  });
});
