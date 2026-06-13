import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/llm/client';

describe('extractJson', () => {
  it('解析纯 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('解析 ```json 代码围栏中的 JSON', () => {
    const text = '```json\n{"matchScore":80}\n```';
    expect(extractJson(text)).toEqual({ matchScore: 80 });
  });

  it('解析无标记代码围栏', () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('从夹带说明文字中截取首个 JSON 对象', () => {
    const text = '好的，结果如下：{"x": [1, 2, 3]} 希望对你有帮助';
    expect(extractJson(text)).toEqual({ x: [1, 2, 3] });
  });

  it('解析 JSON 数组', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('找不到 JSON 时抛错', () => {
    expect(() => extractJson('完全没有结构化内容')).toThrow();
  });
});
