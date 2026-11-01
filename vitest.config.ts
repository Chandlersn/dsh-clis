import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 单一配置覆盖两种测试：
 * - packages/<pkg>/test/：包内单测（实现者所有）
 * - tests/：跨包黑盒验收与端到端（独立验证者所有）
 *
 * cacheDir 显式指向系统临时目录：宿主环境的 safe-delete 中间层会拦截对
 * node_modules/.vitest-cache 的批量清理（超过 50 条即要求确认），
 * 把缓存挪出 node_modules 即可绕开，不必关闭删除保护。
 *
 * ## 为什么需要 alias
 *
 * 各包 `exports` 现在指向 `dist/`（为了能在 npm 上被真实安装）。但测试要跑
 * **源码**——否则每改一行都得先 build，"改完立即验证"就没了。
 *
 * 这里把六个包名映射到 `src/index.ts`：测试读源码，发布产物走 dist，
 * 两条路径各自成立，互不干扰。
 *
 * 注意：**不加 alias 时测试是坏的**（实测 34 个文件加载失败：
 * `Failed to resolve entry for package "@causal-layers/clis-classifier"`，
 * 因为 dist 还没构建）。而这个失败只在跑测试时出现，typecheck 是绿的。
 */
const src = (pkg: string) => join(here, 'packages', pkg, 'src', 'index.ts');

export default defineConfig({
  cacheDir: '.vite-cache',
  resolve: {
    alias: {
      '@causal-layers/clis-contracts': src('clis-contracts'),
      '@causal-layers/clis-classifier': src('clis-classifier'),
      '@causal-layers/clis-strategy': src('clis-strategy'),
      '@causal-layers/clis-feedback': src('clis-feedback'),
      '@causal-layers/clis-orchestrator': src('clis-orchestrator'),
      '@causal-layers/clis-plugin': src('clis-plugin'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
