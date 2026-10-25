/**
 * `@deepseek-ai/cordis` 的运行时垫片（esbuild alias 目标）。
 *
 * 源码里写的是 `import { Service } from '@deepseek-ai/cordis'` —— 保持不变。
 * 打包时 esbuild 把这条说明符重定向到本文件，于是 bundle 里不再内联 cordis，
 * 而是运行时从**宿主安装目录**加载那一份。
 *
 * 为什么必须这样：Service 的类身份决定服务是否被宿主承认。
 * 内联会造出第二个 Service 类，实测 `instanceof 宿主Service === false`，
 * 服务虽注册进 ctx 却不被认，依赖它的组件永远等不到 inject。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MARKER = join('node_modules', '@deepseek-ai', 'cordis', 'package.json');

/**
 * 判断目录是否像 DSH 安装目录。
 *
 * @param dir 候选目录。
 * @returns 命中时返回该目录，否则 undefined。
 */
function probe(dir: string | null | undefined): string | undefined {
  if (dir === undefined || dir === null || dir === '') return undefined;
  try {
    return existsSync(join(dir, MARKER)) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从起点逐级上溯，找第一个含标记的目录。
 *
 * @param start 起始路径。
 * @returns 命中的目录或 undefined。
 */
function ascend(start: string | null | undefined): string | undefined {
  if (start === undefined || start === null || start === '') return undefined;
  let current: string;
  try {
    current = resolve(start);
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 12; depth += 1) {
    const hit = probe(current);
    if (hit !== undefined) return hit;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * 取当前进程的 require.cache（CommonJS 模块表）。
 *
 * @returns 模块表；取不到时 undefined。
 */
function getRequireCache() {
  try {
    return createRequire(import.meta.url).cache;
  } catch {
    return undefined;
  }
}

/**
 * 从**已加载模块**里找宿主安装目录。
 *
 * 宿主装载插件时，cordis / dsh-* 这些包早已在 require.cache 里。
 * 顺着它们的真实路径上溯就能找到安装根 —— 这比猜 cwd 可靠得多。
 *
 * @returns 命中的安装目录或 undefined。
 */
function probeFromLoadedModules() {
  const cache = getRequireCache();
  if (cache === undefined) return undefined;

  const marker = join('node_modules', '@deepseek-ai');
  for (const filename of Object.keys(cache)) {
    if (!filename.includes(marker)) continue;
    const hit = ascend(dirname(filename));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 探测宿主 DSH 安装目录。
 *
 * **探测顺序很重要**：cwd 必须放最后。
 * 开发仓库自己也装了 @deepseek-ai/cordis（devDependency），若 cwd 优先命中，
 * 会加载到开发仓库那份而不是宿主那份 —— 两者是不同模块实例，
 * Service 类身份不一致，服务就不会被宿主承认。
 *
 * @returns 安装目录绝对路径。
 * @throws 全部失败时抛错并提示设置 DSH_INSTALL_DIR。
 */
export function resolveDshRoot() {
  const fromEnv =
    probe(process.env.DSH_INSTALL_DIR) ??
    probe(process.env.DSH_ROOT) ??
    probe(process.env.DSH_HOME);
  if (fromEnv !== undefined) return fromEnv;

  // 最可靠：宿主进程的 argv[1] 就是 <dshRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const fromArgv = ascend(process.argv[1]);
  if (fromArgv !== undefined) return fromArgv;

  // 其次：已加载模块表里宿主包的真实路径
  const fromLoaded = probeFromLoadedModules();
  if (fromLoaded !== undefined) return fromLoaded;

  // profile 目录位于 <dshHome>/profiles/<name>；dshHome 未必与安装目录同盘
  const fromProfile = ascend(process.env.DSH_PROFILE_DIR);
  if (fromProfile !== undefined) return fromProfile;

  // cwd 放最后：开发仓库自己也装了 cordis，优先命中会加载错的那份
  const fromCwd = ascend(process.cwd());
  if (fromCwd !== undefined) return fromCwd;

  throw new Error(
    'CLIS 无法定位 DSH 安装目录（未找到 node_modules/@deepseek-ai/cordis）。请设置环境变量 DSH_INSTALL_DIR 指向 DSH 安装目录。',
  );
}

/** 以宿主安装目录为基址的 require（懒初始化）。 */
let hostRequire: NodeRequire | undefined;

/**
 * 加载宿主的某个包，保证与宿主同一实例。
 *
 * @param specifier 包说明符。
 * @returns 宿主那份包的导出。
 */
export function loadHost(specifier: string): Record<string, unknown> {
  if (hostRequire === undefined) {
    const root = resolveDshRoot();
    hostRequire = createRequire(join(root, 'node_modules', 'noop.cjs'));
  }
  return hostRequire(specifier);
}

/** 宿主的 cordis 导出（require(esm) 返回宿主已缓存的同一实例）。 */
const host = loadHost('@deepseek-ai/cordis');

/** 宿主那份 Service 基类 —— 子插件必须继承它，服务才会被宿主承认。 */
export const Service = host.Service;

/** 宿主那份 Context 类。 */
export const Context = host.Context;

/** 其余常用导出透传。 */
export const symbols = host.symbols;
export const Fiber = host.Fiber;
export const RegistryService = host.RegistryService;
export const Inject = host.Inject;

export default host;
