import { defineConfig } from 'vitest/config';

/**
 * 单一配置覆盖两种测试：
 * - packages/<pkg>/test/：包内单测（实现者所有）
 * - tests/：跨包黑盒验收与端到端（独立验证者所有）
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});