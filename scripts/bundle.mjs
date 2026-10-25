import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 把 CLIS 打成宿主可加载的 bundle。
 *
 * 产出**五个**入口：
 *   index.js（包根，聚合四组件；Loader 靠它判定整包合法性）
 *   clis-classifier.js / clis-strategy.js / clis-feedback.js / clis-orchestrator.js
 *
 * 三个关键决策：
 *
 * 1) **必须有包根入口**：Loader 解析 bundle 时先按 `exports["."]` 判断包是否可装载。
 *    缺包根时整包被跳过，表现为四个子行都停在 `absent`、面板显示关闭且打不开。
 *
 * 2) **cordis 不内联，走 shim**：alias 到 cordis-shim.ts，运行时用 createRequire
 *    从宿主安装目录加载那一份。内联会造出第二个 Service 类
 *    （实测 instanceof 宿主Service === false），服务虽注册进 ctx 却不被承认。
 *
 * 3) **splitting**：五个入口共享同一份 chunk，避免多份副本。
 */
mkdirSync('bundle', { recursive: true });

await build({
  entryPoints: {
    index: 'packages/clis-plugin/src/index.ts',
    'clis-classifier': 'packages/clis-classifier/src/index.ts',
    'clis-strategy': 'packages/clis-strategy/src/index.ts',
    'clis-feedback': 'packages/clis-feedback/src/index.ts',
    'clis-orchestrator': 'packages/clis-orchestrator/src/index.ts',
  },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outdir: 'bundle',
  tsconfig: 'tsconfig.build.json',
  logLevel: 'warning',
  alias: {
    '@deepseek-ai/cordis': resolve('packages/clis-plugin/src/cordis-shim.ts'),
  },
});

console.log('bundle/ written: root + 4 component entries + shared chunks (cordis via host shim)');
