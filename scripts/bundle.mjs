import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * 把换装内核**作为产物的一部分**写出来。
 *
 * ## 为什么内核要随产物交付（2026-10-30）
 *
 * 内核此前只由运行中的代码在检测到变化时写到磁盘。而 `deploy.ps1` 同步产物
 * 时会先删掉插件目录下所有文件 —— 内核一起没了。若产物里不带内核，那一次
 * 换装就没有内核可用，只能等下一次。
 *
 * 随产物交付后，部署完成时磁盘上就有**当前版本**的内核，换装能立刻用上。
 *
 * ## 它**不能**消除首轮重启（诚实的边界）
 *
 * 曾设想"内核带版本号 + 不降级"能让旧监视器读到新内核后自动接管。
 * 真机验证推翻了：旧监视器读到新内核也不会调 `reloadEntries` —— 那个函数
 * 在旧代码里不存在。根本原因是**监视器无法替换自身**，首轮仍需重启一次。
 * 详见 hot-reload.ts 里 `ensureReloadCore` 的注释。
 *
 * 内核源码是 `hot-reload.ts` 里的 `RELOAD_CORE_SOURCE` 字符串。这里从
 * **源码**里抽出来（而不是另存一份），保证只有一份真相源。
 */
const hotReloadSource = readFileSync(resolve('packages/clis-plugin/src/hot-reload.ts'), 'utf8');
const coreMatch = /const RELOAD_CORE_SOURCE = String\.raw`([\s\S]*?)`;\n/u.exec(hotReloadSource);
if (coreMatch === null) {
  console.error('无法从 hot-reload.ts 抽出 RELOAD_CORE_SOURCE —— 内核产物无法生成');
  process.exit(1);
}
const coreSource = coreMatch[1];
if (!/export const CORE_VERSION = \d+/u.test(coreSource)) {
  console.error('内核缺少 CORE_VERSION —— 自举时会反复覆盖，拒绝生成');
  process.exit(1);
}
writeFileSync(resolve('bundle/reload-core.mjs'), coreSource, 'utf8');

console.log('bundle/ written: root + 4 component entries + shared chunks (cordis via host shim)');
console.log('bundle/reload-core.mjs written (内核随产物交付，部署后换装立刻可用)');
