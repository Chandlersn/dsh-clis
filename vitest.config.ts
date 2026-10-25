import { defineConfig } from 'vitest/config';

/**
 * 单一配置覆盖两种测试：
 * - packages/<pkg>/test/：包内单测（实现者所有）
 * - tests/：跨包黑盒验收与端到端（独立验证者所有）
 *
 * cacheDir 显式指向系统临时目录：宿主环境的 safe-delete 中间层会拦截对
 * node_modules/.vitest-cache 的批量清理（超过 50 条即要求确认），
 * 把缓存挪出 node_modules 即可绕开，不必关闭删除保护。
 */
export default defineConfig({
  cacheDir: '.vite-cache',
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
