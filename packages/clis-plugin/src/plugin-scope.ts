import type { Context } from '@deepseek-ai/cordis';

import type { ProbeSource } from './health-supervisor';

/**
 * 系统级插件发现 + **自动探针生成**。
 *
 * ## 为什么需要自动生成（2026-10-26 用户指出的关键点）
 *
 * 用户的判断："应该是 clis 自己就知道加，如果不是这样的机制，那后续增加的
 * 插件它也不可能知道。"
 *
 * 这一条决定架构。若监督依赖"插件自己实现探针并主动上报"，那么：
 * - 每个新插件都得改自己的代码来配合 CLIS；
 * - 插件作者不知道有这个约定时，它永远进不了监督范围；
 * - 结果是"装了新插件 → 盲区扩大"，与系统级监督的目标相反。
 *
 * ## 两层机制
 *
 * **第一层：自动（无需插件配合）—— 覆盖 100% 非内建插件**
 * 全部从宿主元数据推导，插件什么都不用做：
 * - `entry.fiber.state` → 卡在装载 / 意外未激活
 * - `entry.options.inject` → 声明的依赖没被满足（静默失效的典型形态）
 *
 * **第二层：协作（插件自愿）—— 更丰富的领域信号**
 * 插件从模块根导出 `healthProbe`（对象含 probe()）或 `probe`（函数），
 * CLIS 自动发现并使用。**不需要 emit、不需要注册**，只是导出即可。
 *
 * 两层叠加的效果：装任何新插件，第一层立即生效；插件作者若愿意加
 * 一个导出，第二层自动升级它的监督质量。
 */

/** 宿主 loader 的最小结构。 */
interface LoaderLike {
  entries?: () => Iterable<LoaderEntry>;
}

/** 一个 loader entry 的最小结构。 */
interface LoaderEntry {
  readonly options?: {
    id?: unknown;
    name?: unknown;
    inject?: unknown;
    group?: unknown;
  };
  readonly fiber?: { state?: unknown };
  readonly moduleNamespace?: unknown;
  readonly disabled?: unknown;
}

/** 一个被发现的插件。 */
export interface DiscoveredPlugin {
  /** 插件 id（loader 的 options.id）。 */
  readonly id: string;
  /** fiber 状态：0=未激活 1=装载中 2=活动。 */
  readonly state: number;
  /** 是否为非内建插件（用户/第三方装的）—— 只有这些才参与监督。 */
  readonly external: boolean;
  /** 是否被配置显式关闭（关闭的不算盲区，是用户意图）。 */
  readonly disabled: boolean;
  /** 声明的依赖服务名（来自 options.inject）。 */
  readonly declaredInject: readonly string[];
  /** 插件模块根导出的探针（若有）—— 协作层。 */
  readonly probeExport: unknown;
  /**
   * 模块是否**导入成功**。
   *
   * Loader 的 `_init()` 只在 import 成功后给 `moduleNamespace` 赋值；import
   * 失败时只记一条 logger.error 就返回。所以这个字段为空 + 未在导入中
   * = 模块根本没进来 —— 也就是「缺 `exports["."]` 导致整个包被静默跳过」
   * 这类故障（CLIS 自己踩过一次）。
   */
  readonly moduleLoaded: boolean;
  /**
   * 导出形态是否**符合 harness 标准**。
   *
   * Loader 的 `unwrapExports` 优先取 `default`，否则用整个命名空间；因此
   * 合法形态只有两种：`default` 是函数（Service 类或 apply），或有具名
   * `apply`。两者都无 = 模块进来了但注册不成插件。
   */
  readonly exportForm: 'default' | 'apply' | 'invalid' | 'unknown';
  /** 是否是分组条目（分组是容器，没有模块，不该按插件检查）。 */
  readonly isGroup: boolean;
  /** import 是否仍在进行中（进行中不算失败）。 */
  readonly importing: boolean;
  /** 保留 entry 引用，供探针在**执行时**重新读状态（发现装载中途的状态）。 */
  readonly live: unknown;
}

/** 宿主内建服务的命名特征（前缀）。 */
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

  // 3. 用户插件的强特征：dsh- 前缀，直接判为用户插件
  if (id.startsWith('dsh-')) return false;

  // 4. 明确是内建命名段（前缀匹配）
  for (const seg of BUILTIN_SEGMENTS) {
    if (id === seg || id.startsWith(seg)) return true;
  }

  // 5. 子串匹配：内建服务常把段名放在中间
  for (const part of BUILTIN_SUBSTRINGS) {
    if (id.includes(part)) return true;
  }

  // 6. 其余保守判为"非内建"：
  //    宁可多监督一个，也不要漏掉用户插件
  return false;
}

/**
 * 从 entry 的 moduleNamespace 里找插件自愿导出的探针。
 *
 * 约定（任一即可）：
 * - `healthProbe`：对象，含 `probe()` 方法
 * - `probe`：函数，调用返回 HealthReport
 *
 * @param namespace 插件模块的导出对象。
 * @returns 探针导出；无则 undefined。
 */
function findProbeExport(namespace: unknown): unknown {
  if (namespace === null || namespace === undefined || typeof namespace !== 'object') return undefined;
  const ns = namespace as Record<string, unknown>;

  const candidate = ns['healthProbe'] ?? ns['probe'];
  if (candidate === null || candidate === undefined) return undefined;

  if (typeof candidate === 'object') {
    return typeof (candidate as { probe?: unknown }).probe === 'function' ? candidate : undefined;
  }
  if (typeof candidate === 'function') return candidate;

  return undefined;
}

/**
 * 归一化 inject 声明（数组或对象形式都接受）。
 *
 * @param raw entry.options.inject。
 * @returns 服务名列表。
 */
function normalizeInject(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }
  if (typeof raw === 'object') return Object.keys(raw);
  return [];
}

/**
 * 枚举宿主当前的插件列表，并带上自动监督所需的全部元数据。
 *
 * **这是系统级监督的基础**：返回宿主真值，不是 CLIS 的名单。
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

      let disabled = false;
      try {
        disabled = entry.disabled === true;
      } catch {
        // disabled 是 getter，理论上可能抛；抛了就当未关闭
      }

      found.push({
        id: rawId,
        state,
        external: !isBuiltin(rawId),
        disabled,
        declaredInject: normalizeInject(entry.options?.inject),
        probeExport: findProbeExport(entry.moduleNamespace),
        moduleLoaded: entry.moduleNamespace !== undefined,
        exportForm: detectExportForm(entry.moduleNamespace),
        isGroup: Boolean((entry.options as { group?: unknown } | undefined)?.group),
        importing: (entry as { _initTask?: unknown })._initTask !== undefined,
        live: entry,
      });
    }
  } catch {
    return [];
  }
  return found;
}

/**
 * 判断模块的导出形态是否符合 harness 标准。
 *
 * Loader 的 `unwrapExports` 是：`exports.default ?? exports`，再对
 * `__esModule` 的情况再取一次 `default`。所以合法形态只有两种：
 * - `default` 是函数（Service 类，或本身就是 apply）
 * - 没有 default、但有具名 `apply`
 *
 * 两者都无 ⇒ 模块导入成功却注册不成插件 —— 这种失败只会在 Loader 里
 * 抛错，插件侧看不到任何提示。
 *
 * @param namespace 插件模块的导出对象。
 * @returns 形态标签。
 */
function detectExportForm(namespace: unknown): DiscoveredPlugin['exportForm'] {
  if (namespace === null || namespace === undefined) return 'unknown';
  if (typeof namespace !== 'object') {
    // 默认导出被直接当作命名空间的情况（极少见）
    return typeof namespace === 'function' ? 'default' : 'invalid';
  }
  const ns = namespace as Record<string, unknown>;
  if (typeof ns['default'] === 'function') return 'default';
  if (typeof ns['apply'] === 'function') return 'apply';
  return 'invalid';
}

/** 读取 entry 的**当前**状态（可能与 listPlugins 时不同）。 */
function liveState(plugin: DiscoveredPlugin): number {
  try {
    const entry = plugin.live as LoaderEntry | undefined;
    return typeof entry?.fiber?.state === 'number' ? entry.fiber.state : plugin.state;
  } catch {
    return plugin.state;
  }
}

/** 检查一个服务是否可用（用 ctx.get 而非属性访问：未 inject 的键会抛错）。 */
function serviceAvailable(ctx: Context, name: string): boolean {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof getter !== 'function') return true; // 无从判断时不报假警
  try {
    return getter.call(ctx, name) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 造一个**自动结构探针**：完全从宿主元数据推导，插件无需任何配合。
 *
 * 检查项都是"静默失效"的典型形态 —— 不查就会一直没人发现：
 * 1. **模块没导入成功**：`moduleNamespace` 为空。最典型的成因是
 *    `package.json` 缺 `exports["."]` —— Loader 会**静默跳过整个包**，
 *    patch 行全 absent，没有任何报错（CLIS 自己踩过一次）。
 * 2. **导出形态不符合标准**：模块进来了却没有可用的 `default` 或 `apply`；
 *    `unwrapExports` 拿不到插件，注册不成。
 * 3. **卡在装载**（state 1）：通常是 inject 未被满足，插件从未真正生效；
 * 4. **意外未激活**（state 0、且未被显式关闭）：装载失败后残留的条目；
 * 5. **声明的依赖未被满足**：插件自己以为能拿到，实际拿不到。
 *
 * @param ctx 插件上下文。
 * @param plugin 被监督的插件。
 * @returns 探针来源。
 */
function structuralProbe(ctx: Context, plugin: DiscoveredPlugin): ProbeSource {
  return {
    plugin: plugin.id,
    probe: async () => {
      const findings: Array<{
        code: string;
        severity: 'info' | 'warn' | 'error';
        message: string;
        hint?: string;
      }> = [];

      const state = liveState(plugin);

      // 1. 模块没导入成功。
      //    只在"确实不在导入中、也未被关闭、且不是分组"时判 —— 否则会把
      //    还在装载的条目误报成失败。用 warn 而非 error：导入失败通常
      //    在宿主日志里有一条 logger.error，且若只是尚未开始，下一轮就消失。
      if (!plugin.disabled && !plugin.isGroup && !plugin.importing && !plugin.moduleLoaded) {
        findings.push({
          code: 'auto.import-failed',
          severity: 'warn',
          message: `${plugin.id} 的模块没有导入成功：它不会提供任何功能`,
          hint:
            '最常见成因是 package.json 缺 exports["."]（Loader 会静默跳过整个包，patch 行全 absent）；' +
            '其次是模块在导入期抛错 —— 两者都会在宿主日志留一条 error',
        });
      }

      // 2. 导出形态不符合 harness 标准（模块进来了但注册不成插件）
      if (plugin.moduleLoaded && plugin.exportForm === 'invalid') {
        findings.push({
          code: 'auto.export-form-invalid',
          severity: 'error',
          message: `${plugin.id} 的导出形态不符合插件标准：既没有可用的 default，也没有具名 apply`,
          hint:
            '标准只接受两种形态（不可混用）：export function apply(ctx, config)，' +
            '或 default 导出 Service 类；据此改插件入口',
        });
      }

      // 3. 卡在装载
      if (state === 1) {
        findings.push({
          code: 'auto.fiber-loading',
          severity: 'warn',
          message: `${plugin.id} 一直处于装载中（fiber state=1）：可能依赖未满足或初始化未完成`,
          hint: '装载中的插件不提供任何功能，但通常不报错；查它声明的 inject 是否都能满足',
        });
      }

      // 4. 意外未激活
      if (state === 0 && !plugin.disabled) {
        findings.push({
          code: 'auto.fiber-inactive',
          severity: 'warn',
          message: `${plugin.id} 未被关闭却处于未激活（fiber state=0）：装载可能已失败`,
          hint: '未激活的插件不提供任何功能，也通常不出现在错误日志里；检查它的装载报错',
        });
      }

      // 5. 声明的依赖未被满足 —— 静默失效最常见的形态
      const missing = plugin.declaredInject.filter((name) => !serviceAvailable(ctx, name));
      if (missing.length > 0) {
        findings.push({
          code: 'auto.missing-dependency',
          severity: 'error',
          message: `${plugin.id} 声明的依赖中有 ${missing.length} 个服务不存在：${missing.join('、')}`,
          hint: '依赖未满足会让插件静默停留在等待状态、功能完全不可用；确认提供该服务的插件是否已装载',
        });
      }

      const status = findings.some((f) => f.severity === 'error')
        ? ('failing' as const)
        : findings.length > 0
          ? ('degraded' as const)
          : ('ok' as const);

      return { plugin: plugin.id, status, findings };
    },
  };
}

/**
 * 造一个**导出探针包装**：把插件自愿导出的 probe() 接进监督。
 *
 * 包装的目的：插件自己的 probe() 可能抛错或返回畸形数据。
 * 这里是唯一收口点 —— 必须保证"探针坏了"变成一条可读的发现，
 * 而不是让整个互查塌掉。
 *
 * @param pluginId 插件 id。
 * @param exported 插件导出的探针（对象或函数）。
 * @returns 探针来源。
 */
function wrapExportedProbe(pluginId: string, exported: unknown): ProbeSource {
  return {
    plugin: pluginId,
    probe: async () => {
      try {
        let raw: unknown;

        if (typeof exported === 'function') {
          // 函数形态有两种语义，都支持：
          // - **工厂**：返回 { probe() } —— 适合探针需要运行时配置的场景
          // - **直接 probe()**：返回报告本身 —— 适合无依赖的静态检查
          const first = await (exported as () => unknown)();
          raw =
            first !== null &&
            typeof first === 'object' &&
            typeof (first as { probe?: unknown }).probe === 'function'
              ? await (first as { probe: () => unknown }).probe()
              : first;
        } else {
          raw = await (exported as { probe: () => unknown }).probe();
        }

        const report = raw as { status?: unknown; findings?: unknown };
        const findings = Array.isArray(report?.findings) ? report.findings : [];
        const status =
          report?.status === 'ok' || report?.status === 'degraded' || report?.status === 'failing'
            ? report.status
            : findings.length > 0
              ? ('degraded' as const)
              : ('ok' as const);

        return { plugin: pluginId, status, findings } as never;
      } catch (error) {
        return {
          plugin: pluginId,
          status: 'failing' as const,
          findings: [
            {
              code: 'auto.probe-broken',
              severity: 'error' as const,
              message: `${pluginId} 导出的探针自身抛错：${String((error as Error)?.message ?? error).slice(0, 160)}`,
              hint: '探针坏了会让该插件的问题完全不可观测，比它原本要报的问题更该先修',
            },
          ],
        } as never;
      }
    },
  };
}

/**
 * 为全部非内建插件生成监督来源 —— **自动层覆盖 100%，协作层提升质量**。
 *
 * @param ctx 插件上下文。
 * @param plugins loader 枚举结果。
 * @param explicit 插件显式注册的探针（广播/约定键）—— 它们优先，
 *                 因为那是插件作者专门写的，比自动推导更懂自己的领域。
 * @returns 探针来源与覆盖统计。
 */
export function autoSources(
  ctx: Context,
  plugins: readonly DiscoveredPlugin[],
  explicit: readonly ProbeSource[] = [],
): {
  sources: readonly ProbeSource[];
  /** 非内建、未关闭的插件总数（自动层应覆盖全部）。 */
  total: number;
  /** 有领域探针的（导出的或显式注册的）。 */
  domainCovered: readonly string[];
  /** 只有结构探针、无领域信号的 —— 能发现装载问题，看不到领域内部。 */
  structuralOnly: readonly string[];
} {
  // 名称归一化后再比对：同一个插件可能以不同名字出现 ——
  // 广播时插件自报 `dsh-memory-manager`，而 loader id 是 `memory-manager`。
  // 不归一化会导致同一插件被**探测两次**（一次显式、一次自动）。
  const norm = (name: string): string => name.replace(/^dsh-/u, '').toLowerCase();
  const explicitIds = new Set(explicit.map((item) => norm(item.plugin)));
  const sources: ProbeSource[] = [...explicit];
  const domainCovered: string[] = [...new Set(explicit.map((item) => item.plugin))];
  const structuralOnly: string[] = [];

  const candidates = plugins.filter((item) => item.external && !item.disabled);
  const seen = new Set<string>();

  for (const plugin of candidates) {
    const key = norm(plugin.id);
    if (seen.has(key)) continue;
    seen.add(key);

    // 显式注册的优先（作者专门写的，比自动推导更懂领域）
    if (explicitIds.has(key)) continue;

    if (plugin.probeExport !== undefined) {
      sources.push(wrapExportedProbe(plugin.id, plugin.probeExport));
      domainCovered.push(plugin.id);
      continue;
    }

    // 自动层：无需插件配合
    sources.push(structuralProbe(ctx, plugin));
    structuralOnly.push(plugin.id);
  }

  return { sources, total: candidates.length, domainCovered, structuralOnly };
}

/** 监督作用域。 */
export interface SupervisionScope {
  readonly plugins: readonly string[];
  readonly sources: readonly ProbeSource[];
}

/**
 * 组装监督作用域（保留给只做枚举统计的调用方）。
 *
 * @param plugins loader 枚举结果。
 * @param sources 探针来源。
 * @returns 作用域与统计。
 */
export function buildScope(
  plugins: readonly DiscoveredPlugin[],
  sources: readonly ProbeSource[],
): {
  scope: SupervisionScope;
  activeTotal: number;
  externalTotal: number;
  uncovered: readonly string[];
} {
  const active = plugins.filter((item) => item.state === 2);
  const external = active.filter((item) => item.external && !item.disabled);
  const externalIds = external.map((item) => item.id);

  const probedIds = sources.map((item) => item.plugin);
  const uncovered = externalIds.filter(
    (id) =>
      !probedIds.some((probed) => probed === id || id.endsWith(probed) || probed.endsWith(id)),
  );

  return {
    scope: { plugins: [...probedIds], sources: [...sources] },
    activeTotal: active.length,
    externalTotal: external.length,
    uncovered,
  };
}