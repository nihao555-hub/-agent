import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 测试默认走规则引擎（不联网），并静音日志，保持输出干净、结果确定。
    env: { LOG_LEVEL: 'silent', LLM_API_KEY: '' },
    include: ['test/**/*.test.ts'],
  },
});
