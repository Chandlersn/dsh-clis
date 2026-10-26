import type { Context } from '@deepseek-ai/cordis';

import { ClisHealthProbe } from './health-probe';
import { ProbeRegistry, scanKnownProbes } from './probe-registry';
import type { ProbeSource } from './health-supervisor';
import { registerPromptSection } from './prompt';
import { registerTools } from './tools';

/**
 * 当前插件版本 —— 探针会带上它，便于确认跑的是哪一版。
 *
 * 与 package.json 的 version 手动保持一致：打包时不做注入，
 * 因为 bundle 里读 package.json 会引入额外的路径依赖。
 */
const PLUGIN_VERSION = '0.3.0';

/**
 * CLIS 包根入口 —— 注册 agent 工具与系统提示段，不装载四个组件。
 *
 * 职责划分：
 * - 四个组件各有独立入口（`dsh-clis/classifier` 等），由 patch 里的四行分别装载，
 *   因此它们可以在面板上各自开关。
 * - 包根入口负责两件 agent 侧的事：
 *   1. 注册三个工具（clis_run / clis_classify / clis_plan）；
 *   2. 往系统提示注入一小段"什么时候该想因果结构"的触发条件。
 *
 * 为什么两件都要做：工具表里"有"不等于"会想起来用"。工具 description
 * 只在 agent 主动检索工具时生效；系统提示段则每一轮都在上下文里，
 * 让它在遇到"改了没效果""越调越糟"这类信号时**自然联想到**先判断结构。
 *
 * 为什么不用包根装载组件：那样会让四个组件被装载两次（包根 + 各自入口），
 * 造成服务重复注册。
 *
 * 为什么包根必须存在：Loader 解析 bundle 时先按 `exports["."]` 判断整包合法性，
 * 缺包根会导致整包被跳过（四个子行全部停在 absent）。
 *
 * 两层都只做转发与提示，判据全部在四个组件里：
 * 分类 → classifier，匹配 → strategy，反馈 → feedback，编排 → orchestrator。
 */
export const name = 'clis-tools';

/**
 * 工具注册需要三个服务与 `tools`；系统提示段需要 `systemPrompt`。
 *
 * 若某个组件被用户在面板上关闭，依赖它的工具会因 inject 不满足而停用 ——
 * 这是期望行为：关掉分类器，clis_classify 自然不可用。
 *
 * `systemPrompt` 也放进来：它是宿主内置服务，必然存在；放 inject 里能让
 * 装载顺序正确（服务就位后才 apply），而不是靠运气。
 */
export const inject: string[] = [
  'tools',
  'systemPrompt',
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalOrchestrator',
];

/**
 * 注册 CLIS 工具与系统提示段。
 *
 * @param ctx 插件上下文。
 */
export function apply(ctx: Context): void {
  // CLIS 自己的健康探针：让它能被 clis_probe 自己检查，也示范了
  // HealthProbe 的实现方式 —— 其他插件照这个形状实现即可被纳入互查。
  const probe = new ClisHealthProbe(ctx, PLUGIN_VERSION);

  // 探针注册表：同时支持「广播收集」与「惰性扫描」两种发现方式。
  // 只用自己那份 sources 是错的 —— 那样 clis_probe 永远只查得到自己。
  const registry = new ProbeRegistry();
  registry.add('dsh-clis', () => probe.probe());
  const disposeListen = registry.listen(ctx);

  // 注册表 → 每次调用时重新收集（其他插件可能后装载）。
  const sources = (): ProbeSource[] => {
    const collected = registry.sources();
    const known = collected.map((item) => item.plugin);
    return [...collected, ...scanKnownProbes(ctx, known)];
  };

  registerTools(ctx, sources);
  registerPromptSection(ctx);

  // 装载末尾的统一清理：随插件卸载取消订阅。
  // 用 ctx.effect 而非自己跟踪 disposer —— Cordis 保证 fiber 销毁时回调。
  const host = ctx as unknown as {
    effect?: (fn: () => (() => void) | void) => void;
  };
  if (typeof host.effect === 'function') {
    host.effect(() => disposeListen);
  }
}

export { classifyProblem } from '@clis/clis-classifier';
export { matchPaths, executePath, STRATEGY_LIBRARY, STRATEGY_LIBRARY_VERSION } from '@clis/clis-strategy';
export { detectSignal, FEEDBACK_RULES_VERSION } from '@clis/clis-feedback';
export { decide, initialState, ROLLBACK_LIMIT_DEFAULT, TYPE_LOCK_ROUNDS_DEFAULT } from '@clis/clis-orchestrator';
