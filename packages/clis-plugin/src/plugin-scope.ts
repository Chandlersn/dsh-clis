import type { Context } from '@deepseek-ai/cordis';

import type { ProbeSource } from './health-supervisor';

/**
 * 系统级插件发现 —— 只监督**非内部插件**（用户/第三方装的）。
 *
 * ## 为什么必须只监督非内部插件（2026-10-26 真机教训）
 *
 * 第一版枚举 `loader.entries()` 得到的**全部 183 个活动条目**都当成
 * 待监督对象，没探针就报"覆盖盲区"。结果：
 * - 183 条里 90% 是宿主内建服务（llm / session / storage / ui-* …），
 *   它们**本来就不该有健康探针** —— 那是基础设施，不是功能插件；
 * - 用户看到 183 条会直接认为功能坏了；
 * - 真正的信号（memory-manager 没探针之类）被淹没。
 *
 * 用户明确要求：「只监管非内部插件」。
 *
 * ## 判据（不写死白名单）
 *
 * 宿主内建包全部发布在 `@deepseek-ai/` 作用域下，且 loader 的 id 是
 * 简短小写短语（llm / session / storage / ui-chat …）。用户插件是
 * 独立包名（dsh-*、dshmarket、带作者前缀）或 npm 上的公共包。
 *
 * 由于运行时拿不到 profile 的 dependencies 表，判据分两层：
 *
 * 1. **作用域**：id 以 `@deepseek-ai/` 开头 ⇒ 内建
 * 2. **形态**：已知内建命名段（ui-* / session-* / storage-* / llm-* 等）
 *    且不含用户插件特征（dsh- 前缀）⇒ 内建
 *
 * 判错的方向是**保守**：宁可漏掉某个内建插件（把它当用户插件、报一次缺口），
 * 也不要把用户插件误判成内建（那样它会永远不被监督）。
 */

/** 宿主 loader 的最小结构。 */
interface LoaderLike {
  entries?: () => Iterable<LoaderEntry>;
}

/** 一个 loader entry 的最小结构。 */
interface LoaderEntry {
  readonly options?: { id?: unknown; name?: unknown };
  readonly fiber?: { state?: unknown };
}

/** 一个被发现的插件。 */
export interface DiscoveredPlugin {
  /** 插件 id（loader 的 options.id）。 */
  readonly id: string;
  /** fiber 状态：0=未激活 1=装载中 2=活动。 */
  readonly state: number;
  /** 是否为非内部插件（用户/第三方装的）—— 只有这些才参与监督。 */
  readonly external: boolean;
}

/**
 * 宿主内建服务的命名特征。
 *
 * 这些都是宿主自己拆出来的基础设施服务，没有"健康"可言 ——
 * 它们不健康时整个宿主就崩了，轮不到插件探针来报。
 */
const BUILTIN_SEGMENTS = [
  'ui-',
  'session',
  'storage',
  'llm',
  'agent',
  'tool',
  'tools',
  'web',
  'skill',
  'goal',
  'jobs',
  'sandbox',
  'approval',
  'permission',
  'connection',
  'workspace',
  'config',
  'settings',
  'authorization',
  'credential',
  'account',
  'spill',
  'subagent',
  'timeout',
  'image-',
  'repeat-',
  'otel',
  'telemetry',
  'locale',
  'shortcuts',
  'resources',
  'modules',
  'preset',
  'mcp',
  'file-',
  'fs-',
  'shell-',
  'command',
  'terminal',
  'schedule',
  'message-',
  'token-',
  'workflow',
  'trajectory',
  'plan',
  'attachment',
  'remote',
  'typert',
  'cordis',
  'web-startup',
  'webserver',
  'harness-',
  'client-',
  'plugin-',
  'include',
  'timer',
  'hmr',
];

/** 宿主内建服务的**子串**特征（出现在 id 任意位置都算）。 */
const BUILTIN_SUBSTRINGS = [
  'deepseek-',
  'llm-',
  'session-',
  'subagent-',
  'sandbox',
  'storage-',
  'projection',
  'transcript',
  'isolation',
  'permission',
  'approval',
  'credential',
  'authorization',
  'attachment',
  'telemetry',
  'diagnostic',
  'checkpoint',
  'compaction',
  'serialization',
  'user-questions',
  'working-directory',
  'subprocess',
  'system-prompt',
  'open-in-app',
  'directory-picker',
  'job-controller',
  'api-remotes',
  'office-to-pdf',
  'pwsh-',
  'ptc-',
  'experimental-',
  'turn-',
  'usage-',
  'cancel-',
  'shutdown-',
  'startup-',
  'lifecycle',
  'registry',
  'inventory',
];

/**
 * 判断一个 loader id 是否属于宿主内建服务。
 *
 * @param id loader 的 options.id。
 * @returns true 表示内建（不参与监督）。
 */
export function isBuiltin(id: string): boolean {
  // 1. 官方作用域
  if (id.startsWith('@deepseek-ai/')) return true;
  if (id.startsWith('@')) return true;

  // 2. 匿名条目（loader 给随机 8 位十六进制）
  if (/^[0-9a-f]{8}$/u.test(id)) return true;

  // 3. 用户插件的强特征：dsh- 前缀（这不是官方作用域，
  //    是本项目里第三方插件的约定命名），直接判为用户插件
  if (id.startsWith('dsh-')) return false;

  // 4. 明确是内建命名段（前缀匹配）
  for (const seg of BUILTIN_SEGMENTS) {
    if (id === seg || id.startsWith(seg)) return true;
  }

  // 5. 子串匹配：内建服务常把段名放在中间
  //    （deepseek-llm-api-extensions / tool-working-directory …）
  for (const part of BUILTIN_SUBSTRINGS) {
    if (id.includes(part)) return true;
  }

  // 6. 其余保守判为"非内建"（参与监督）：
  //    宁可多监督一个，也不要漏掉用户插件
  return false;
}

/**
 * 枚举宿主当前的插件列表。
 *
 * **这是系统级监督的基础**：返回宿主真值，不是 CLIS 的名单。
 * 新装插件自动出现，无需改代码。
 *
 * @param ctx 插件上下文。
 * @returns 已装载的插件列表；宿主没有 loader 时返回空数组。
 */
export function listPlugins(ctx: Context): DiscoveredPlugin[] {
  const loader = (ctx as unknown as { loader?: LoaderLike }).loader;
  if (loader === undefined || typeof loader.entries !== 'function') return [];

  const found: DiscoveredPlugin[] = [];
  try {
    for (const entry of loader.entries()) {
      const rawId = entry.options?.id ?? entry.options?.name;
      if (typeof rawId !== 'string' || rawId.length === 0) continue;
      const state = typeof entry.fiber?.state === 'number' ? entry.fiber.state : 0;
      found.push({ id: rawId, state, external: !isBuiltin(rawId) });
    }
  } catch {
    // loader 异常时退回空列表：监督能力受损，但不影响 CLIS 本身可用
    return [];
  }
  return found;
}

/** 监督作用域。 */
export interface SupervisionScope {
  /** 参与监督的插件 id（提供探针的）。 */
  readonly plugins: readonly string[];
  /** 探针来源。 */
  readonly sources: readonly ProbeSource[];
}

/**
 * 组装监督作用域：只统计非内建插件。
 *
 * @param plugins loader 枚举结果。
 * @param sources 已注册探针。
 * @returns 作用域与统计。
 */
export function buildScope(
  plugins: readonly DiscoveredPlugin[],
  sources: readonly ProbeSource[],
): {
  scope: SupervisionScope;
  /** 活动插件总数（含内建，仅用于展示系统规模）。 */
  activeTotal: number;
  /** 非内建（用户/第三方）活动插件数 —— 这才是监督对象的规模。 */
  externalTotal: number;
  /** 用户插件里尚未接入探针的。 */
  uncovered: readonly string[];
} {
  const active = plugins.filter((item) => item.state === 2);
  const external = active.filter((item) => item.external);
  const externalIds = external.map((item) => item.id);

  const probedIds = sources.map((item) => item.plugin);

  const uncovered = externalIds.filter(
    (id) =>
      !probedIds.some(
        (probed) => probed === id || id.endsWith(probed) || probed.endsWith(id),
      ),
  );

  return {
    scope: { plugins: [...probedIds], sources: [...sources] },
    activeTotal: active.length,
    externalTotal: external.length,
    uncovered,
  };
}
