import type { Context } from '@deepseek-ai/cordis';
import type { HealthProbe } from '@clis/clis-contracts';

import type { ProbeSource } from './health-supervisor';

/**
 * 探针发现：让 CLIS 自动找到其他插件注册的健康探针。
 *
 * 为什么需要这一层（2026-10-26 真机踩到）：
 * 最初 `registerTools(ctx, healthSources)` 只接受**自己传入**的探针列表，
 * 于是 `clis_probe` 永远只探测 CLIS 自己 —— 互查机制形同虚设。
 *
 * 两种发现方式，都支持：
 *
 * 1. **主动广播**（推荐）：插件装载时 `ctx.emit('clis/register-probe', { plugin, probe })`，
 *    CLIS 订阅后收进注册表。适用于本插件自身。
 *
 * 2. **惰性扫描**（兜底）：`ctx.get('memory.healthProbe')` 之类的约定键。
 *    适用于不方便改代码发事件的插件 —— 但需要知道对方的键名。
 *
 * 为什么用事件而不用服务注册：Cordis 的 `ctx.set` 需要预先声明服务名，
 * 而探针是一种"多播"资源（多个插件各自提供一份），事件天然支持多播。
 */

/** 探针注册事件名。插件装载时 emit 一次即可。 */
export const REGISTER_PROBE_EVENT = 'clis/register-probe';

/** 广播载荷。 */
export interface RegisterProbePayload {
  /** 插件名（与 package.json 的 name 一致）。 */
  readonly plugin: string;
  /** 探针实现。 */
  readonly probe: HealthProbe['probe'];
}

/**
 * 探针注册表：收集所有广播过来的探针。
 */
export class ProbeRegistry {
  /** plugin → probe 函数。 */
  private readonly table = new Map<string, HealthProbe['probe']>();

  /**
   * 登记一个探针。重复登记同一插件名会覆盖（以最后一次为准）。
   *
   * @param plugin 插件名。
   * @param probe 探针函数。
   * @returns 注销函数。
   */
  add(plugin: string, probe: HealthProbe['probe']): () => void {
    this.table.set(plugin, probe);
    return () => {
      // 只在仍是自己时删除，避免覆盖后被误删
      if (this.table.get(plugin) === probe) this.table.delete(plugin);
    };
  }

  /**
   * 订阅广播，自动收集探针。
   *
   * @param ctx 插件上下文。
   * @returns 注销函数。
   */
  listen(ctx: Context): () => void {
    const host = ctx as unknown as {
      on?: (name: string, listener: (payload: unknown) => void) => () => void;
    };
    if (typeof host.on !== 'function') return () => {};

    return host.on(REGISTER_PROBE_EVENT, (payload) => {
      if (payload === null || typeof payload !== 'object') return;
      const notice = payload as Partial<RegisterProbePayload>;
      if (typeof notice.plugin !== 'string' || typeof notice.probe !== 'function') return;
      this.add(notice.plugin, notice.probe);
    });
  }

  /**
   * 转成 HealthSupervisor 需要的来源列表。
   *
   * @returns 探针来源。
   */
  sources(): ProbeSource[] {
    return [...this.table.entries()].map(([plugin, probe]) => ({
      plugin,
      probe: async () => probe(),
    }));
  }

  /** 已收集的插件名。 */
  plugins(): string[] {
    return [...this.table.keys()];
  }

  /** 当前数量。 */
  get size(): number {
    return this.table.size;
  }
}

/**
 * 尝试从约定的服务键惰性发现探针。
 *
 * 约定键：`<plugin>.healthProbe`。目前支持已知的几个（硬编码，
 * 因为 `ctx.get` 不能遍历所有键）。新增插件时在此追加即可。
 */
const KNOWN_PROBE_KEYS: readonly string[] = [
  'clis.healthProbe',
  'memory.healthProbe',
];

/**
 * 惰性扫描已知的探针服务键。
 *
 * @param ctx 插件上下文。
 * @param already 已通过广播收集到的插件名（避免重复）。
 * @returns 额外发现的探针来源。
 */
export function scanKnownProbes(
  ctx: Context,
  already: readonly string[],
): ProbeSource[] {
  const found: ProbeSource[] = [];
  const getter = (ctx as unknown as { get?: (name: string) => unknown }).get;
  if (typeof getter !== 'function') return found;

  const seen = new Set(already);

  for (const key of KNOWN_PROBE_KEYS) {
    let value: unknown;
    try {
      value = getter.call(ctx, key);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const candidate = value as Partial<HealthProbe>;
    if (typeof candidate.probe !== 'function') continue;

    // 用探针自报的 plugin 名去重；没报就用键名
    const plugin = (value as { plugin?: unknown }).plugin;
    const name = typeof plugin === 'string' ? plugin : key;
    if (seen.has(name)) continue;
    seen.add(name);

    const probeFn = candidate.probe.bind(value);
    found.push({ plugin: name, probe: async () => probeFn() });
  }

  return found;
}
