import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

/**
 * 把 CLIS 打成可被 DSH 宿主加载的单文件 bundle。
 *
 * 为什么必须打包而不是 tsc emit：
 * - tsc 产出的相对导入没有扩展名，Node ESM 无法解析；
 * - tsc 的 paths 映射只在编译期生效，跨包 import 会被抹掉。
 *
 * 为什么 cordis 也一起内联（不外置）：
 * profile 安装的 bundle 以 junction 指向 default-workspace，其 realpath 下没有
 * 宿主的 node_modules/@deepseek-ai/*，裸导入必然 ERR_MODULE_NOT_FOUND。
 * 内联后文件自包含；实测内联出的 Service 与宿主是**同一个类身份**
 * （宿主 Context 能正常装载并看到四个服务，卸载也干净），所以不会出现
 * "两份注册表、inject 永远等不到"的问题。
 */
mkdirSync('bundle', { recursive: true });

await build({
  entryPoints: ['packages/clis-plugin/src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'bundle/clis.js',
  tsconfig: 'tsconfig.build.json',
  logLevel: 'warning',
});

console.log('bundle/clis.js written');
