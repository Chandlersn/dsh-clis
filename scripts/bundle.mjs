import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

/**
 * 把 CLIS 打成宿主可加载的 bundle。
 *
 * 产出**四个独立入口**，对应面板上四个可各自开关的组件：
 *   clis-classifier.js / clis-strategy.js / clis-feedback.js / clis-orchestrator.js
 *
 * 用 `splitting: true` 让四个入口共享同一份 cordis 与 contracts chunk ——
 * 否则会打出四份 cordis 副本（体积翻四倍，且 Service 类身份分散）。
 *
 * 为什么 cordis 一起内联：profile 安装的 bundle 以 junction 指向 default-workspace，
 * realpath 下没有宿主的 node_modules/@deepseek-ai/*，裸导入必然 ERR_MODULE_NOT_FOUND。
 * 实测内联出的 Service 仍能向宿主 Context 注册服务（注册走 ctx.reflect.provide，
 * 用的是宿主传进来的 ctx），因此服务对宿主可见、卸载也干净。
 */
mkdirSync('bundle', { recursive: true });

await build({
  entryPoints: {
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
});

console.log('bundle/ written: 4 entries + shared chunks');
