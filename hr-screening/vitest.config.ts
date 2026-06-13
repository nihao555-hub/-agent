import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { LOG_LEVEL: 'silent', LLM_API_KEY: '' },
    include: ['test/**/*.test.ts'],
  },
});
