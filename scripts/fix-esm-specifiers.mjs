/**
 * 构建后处理：给产物里的相对 import 补上 `.js` 后缀。
 *
 * ## 为什么必须有这一步
 *
 * TS 编译产物保留了源码里的无扩展名相对引用（`from './causal-type'`），
 * 这在 `moduleResolution: bundler` 下能过类型检查，**但 Node ESM 加载不了**：
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/causal-type'
 *
 * 试过 `module: NodeNext` —— 同样保留无后缀（TS 只在**源码**写了 `.js`
 * 时才算它是对的，自己不会补）。所以只能在产物层面补。
 *
 * ## 为什么不用 esbuild/rollup 打包
 *
 * 打包会把多个模块合成一个文件，破坏"每个源文件对应一个产物"的对应关系，
 * 也就破坏了 `exports` 里可能的子路径导出，且让 stack trace 的定位变难。
 * 只改 import 后缀，产物的模块结构完全不变 —— 这是最小、最可预测的改动。
 *
 * ## 只处理相对引用
 *
 * 裸包名（`@deepseek-ai/cordis`）不能加后缀，否则解析失败。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// dist 目录从命令行取（`npm run build` 在各自的包目录里跑），
// 不写死成脚本旁边的 dist —— 那会让每个包都要复制一份脚本。
const distDir = resolve(process.argv[2] ?? join(here, '..', 'dist'));

/**
 * 给一段 JS 文本里的相对 import/export 补后缀。
 *
 * 覆盖四种真实出现的形式：
 *   import ... from './x'
 *   export ... from './x'
 *   import './x'            （副作用导入）
 *   await import('./x')     （动态导入）
 *
 * 已有 `.js` 的不动；带 `.json` / `.node` 等既有后缀的也不动。
 *
 * @param source — 文件内容。
 * @returns 处理后内容。
 */
function addJsExtensions(source) {
  // 匹配 from './x' 或 from '../x'
  let out = source.replace(
    /(\bfrom\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g,
    (match, pre, spec, post) => {
      if (/\.[a-z0-9]+$/i.test(spec)) return match; // 已有后缀
      return `${pre}${spec}.js${post}`;
    },
  );

  // 匹配 import './x'（无 from 的副作用导入）
  out = out.replace(
    /(\bimport\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g,
    (match, pre, spec, post) => {
      if (/\.[a-z0-9]+$/i.test(spec)) return match;
      return `${pre}${spec}.js${post}`;
    },
  );

  // 匹配动态 import('./x')
  out = out.replace(
    /(\bimport\(\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g,
    (match, pre, spec, post) => {
      if (/\.[a-z0-9]+$/i.test(spec)) return match;
      return `${pre}${spec}.js${post}`;
    },
  );

  return out;
}

/** 递归遍历目录。 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!statSync(distDir, { throwIfNoEntry: false })) {
  console.error('✘ dist 不存在，先跑 tsc');
  process.exit(1);
}

let changed = 0;
for (const file of walk(distDir)) {
  // .js 的 import 要补；.d.ts 里的类型引用同样需要（供 NodeNext 消费方解析）
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const before = readFileSync(file, 'utf8');
  const after = addJsExtensions(before);
  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    changed += 1;
  }
}

console.log(`✔ 已为 ${changed} 个产物文件补全相对 import 的 .js 后缀`);
