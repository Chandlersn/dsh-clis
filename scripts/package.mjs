/**
 * 组装可安装的插件产物。
 *
 * ## 为什么需要它（2026-10-26 开源就绪度审计发现）
 *
 * 审计发现：插件的非 JS 资产（`cordis.patch.yml`、`package.json`、`icon.svg`、
 * `README.md`、四个组件的 `locale/*.json`）**只存在于安装目录**，仓库里一份都没有。
 * 后果是**克隆仓库无法重建可安装的插件** —— 开源的话别人连装都装不上；
 * 对本项目自己也是隐患（安装目录一丢，打包配置就没了）。
 *
 * 现在真值源在仓库里，分两处：
 *
 * | 来源 | 内容 | 由谁产生 |
 * |---|---|---|
 * | `bundle/` | 5 个入口 JS + 共享 chunk | `scripts/bundle.mjs`（esbuild） |
 * | `packaging/` | patch / package.json / icon / README / locale | 手写，受版本控制 |
 *
 * 本脚本把两者合成一份完整插件目录。幂等：可反复跑。
 *
 * ## 本机坑（实测）
 *
 * **`cpSync` 复制目录会崩进程**（退出码 `0xC0000409`，宿主 fs 中间层拦截），
 * 单个文件复制正常。所以这里一律手动遍历、逐文件复制 —— 与 `bundle.mjs`
 * 回避 `rmSync` 是同一类问题。`rmSync` 对文件数不多的目录可用。
 *
 * ## 用法
 *
 * ```
 * node scripts/package.mjs [输出目录]
 * ```
 *
 * 省略输出目录时写到 `dist-package/`（仓库内，已 gitignore）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE = join(ROOT, 'bundle');
const PACKAGING = join(ROOT, 'packaging');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'dist-package'));

/** 断言前置产物存在，缺失时给出可执行的补救命令而不是一堆 ENOENT。 */
function requireDir(path, hint) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(`缺少 ${path}`);
    console.error(`  → ${hint}`);
    process.exit(1);
  }
}

/**
 * 逐文件递归复制。
 *
 * 刻意不用 `cpSync(src, dest, { recursive: true })`：本机上它会让进程崩掉。
 *
 * @param from 源目录。
 * @param to 目标目录。
 * @returns 复制的文件数。
 */
function copyTree(from, to) {
  let count = 0;
  for (const name of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, name.name);
    const dest = join(to, name.name);
    if (name.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      count += copyTree(src, dest);
      continue;
    }
    if (!name.isFile()) continue;
    cpSync(src, dest); // 单文件复制是安全的
    count += 1;
  }
  return count;
}

requireDir(BUNDLE, '先跑 node scripts/bundle.mjs');
requireDir(PACKAGING, 'packaging/ 是受版本控制的手写资产目录，不该缺失');

// 全量重建：留着上一轮的残留文件会让"产物是否真的是这一版"无法判断。
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1) JS 产物
let jsCount = 0;
for (const name of readdirSync(BUNDLE)) {
  if (!name.endsWith('.js')) continue;
  cpSync(join(BUNDLE, name), join(OUT, name));
  jsCount += 1;
}

// 2) 手写资产（含 locale 树）
const assetCount = copyTree(PACKAGING, OUT);

// 3) LICENSE 从仓库根带过来（npm 包与安装目录都需要它）
const license = join(ROOT, 'LICENSE');
if (existsSync(license)) cpSync(license, join(OUT, 'LICENSE'));

// 4) 自检：缺任何一项都会让插件装载失败或显示不全，故在这里就拦住
const REQUIRED = [
  'index.js',
  'clis-classifier.js',
  'clis-strategy.js',
  'clis-feedback.js',
  'clis-orchestrator.js',
  'cordis.patch.yml',
  'package.json',
  'icon.svg',
  'README.md',
  'LICENSE',
  'locale/zh.json',
  'locale/classifier/zh.json',
  'locale/strategy/zh.json',
  'locale/feedback/zh.json',
  'locale/orchestrator/zh.json',
];
const missing = REQUIRED.filter((rel) => !existsSync(join(OUT, rel)));
if (missing.length > 0) {
  console.error(`产物缺 ${missing.length} 项：${missing.join('、')}`);
  process.exit(1);
}

console.log(`packaged: ${jsCount} 个 JS + ${assetCount} 个资产文件 → ${relative(ROOT, OUT)}`);
console.log('  必需文件齐全（含四组件 locale 与 LICENSE）');