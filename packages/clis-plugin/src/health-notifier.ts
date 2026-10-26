import type { Context } from '@deepseek-ai/cordis';

import type { DispositionedFinding } from './health-seen';

/**
 * 双向通报：既告诉**对方插件**，也告诉 **agent 宿主**。
 *
 * 用户要求的三段式（2026-10-26）：
 * 1. 发现问题 → 通报对方插件（它能自己修）
 * 2. 对方修好了 → 不管（下一轮体检看不到它，自动清账）
 * 3. 对方没修/没搞定 → 宿主介入，并**通报给用户**
 *
 * 为什么用"下一轮体检看不到"作为修复判据，而不是让对方回报：
 * 主动回报容易漏报、假报、忘记报；而"问题还在不在"是可观测事实。
 * 代价是慢一轮 —— 这是值得的，因为可靠比快重要。
 *
 * 为什么对方收到事件后**不强制**做什么：
 * 通报是信息，不是命令。插件可以选择自行修复、记录待办、或忽略。
 * 强制会让插件间产生耦合，而这里要的是松耦合的正向循环。
 */

/** 通报事件名。对方用 `ctx.on('clis/health-finding', ...)` 订阅。 */
export const HEALTH_FINDING_EVENT = 'clis/health-finding';

/** 通报给对方的载荷。 */
export interface HealthFindingNotice {
  /** 发现问题的插件（通常是 dsh-clis）。 */
  readonly from: string;
  /** 发现项的稳定代号，用于去重与自己追踪。 */
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  /** 涉及哪些插件。 */
  readonly plugins: readonly string[];
  /** 同类问题出现几次。 */
  readonly count: number;
  /** 这是第几轮仍未解决（1 = 首次发现）。 */
  readonly roundsUnresolved: number;
  /** 一句话方向提示（不是修复指令）。 */
  readonly hint?: string;
}

/** 通报结果。 */
export interface NotifyOutcome {
  /** 成功发给他方插件的事件条数。 */
  readonly notifiedPlugins: number;
  /** 需要通报给用户的条数（含新增与升级）。 */
  readonly forUser: readonly DispositionedFinding[];
  /** 需要单独提示"已修复"的条数。 */
  readonly resolved: readonly DispositionedFinding[];
}

/**
 * 通报器。
 */
export class HealthNotifier {
  /**
   * @param ctx 插件上下文（用于 emit 事件）。
   * @param origin 本插件名。
   */
  constructor(
    private readonly ctx: Context,
    private readonly origin = 'dsh-clis',
  ) {}

  /**
   * 执行双向通报。
   *
   * 通报策略：
   * - `new`：发给对方插件（让它自己修），同时提示 agent
   * - `unresolved`：只发对方（不打扰用户，给它时间）
   * - `escalate`：发对方 + **通报用户**（多轮未修，需要人介入）
   * - `resolved`：不通报，只记一条"已消失"便于确认闭环
   *
   * @param dispositions 处置清单。
   * @param hints code → 方向提示。
   * @returns 通报结果。
   */
  notify(
    dispositions: readonly DispositionedFinding[],
    hints: ReadonlyMap<string, string> = new Map(),
  ): NotifyOutcome {
    let notifiedPlugins = 0;
    const forUser: DispositionedFinding[] = [];
    const resolved: DispositionedFinding[] = [];

    for (const item of dispositions) {
      if (item.disposition === 'resolved') {
        resolved.push(item);
        continue;
      }

      // —— 发给他方插件 ——
      if (item.disposition === 'new' || item.disposition === 'unresolved' || item.disposition === 'escalate') {
        const hint = hints.get(item.code);
        const notice: HealthFindingNotice = {
          from: this.origin,
          code: item.code,
          severity: item.severity,
          message: item.message,
          plugins: item.plugins,
          count: item.count,
          roundsUnresolved: item.roundsUnresolved,
          ...(hint !== undefined ? { hint } : {}),
        };

        try {
          // Cordis emit 是同步派发：对方若订阅了就能收到。
          // 未订阅也不报错 —— 通报是善意提示，不是强制契约。
          (this.ctx as unknown as { emit: (name: string, payload: unknown) => void }).emit(
            HEALTH_FINDING_EVENT,
            notice,
          );
          notifiedPlugins += 1;
        } catch {
          // 事件派发失败不影响主流程：至少 agent 侧还看得到
        }
      }

      // —— 通报给用户 ——
      // 只在两种情况打扰用户：首次发现的新问题、以及多轮未修的升级。
      // `unresolved` 刻意不报 —— 给对方留出修复时间，否则就是噪音。
      if (item.disposition === 'new' || item.disposition === 'escalate') {
        forUser.push(item);
      }
    }

    return { notifiedPlugins, forUser, resolved };
  }
}

/**
 * 把处置结果整形成 agent 可读的通报。
 *
 * @param outcome 通报结果。
 * @param escalateAfter 升级阈值，用于文案。
 * @returns 结构化通报。
 */
export function shapeForAgent(
  outcome: NotifyOutcome,
  escalateAfter: number,
): {
  new_count: number;
  escalated_count: number;
  unresolved_count: number;
  resolved_count: number;
  notified_plugins: number;
  items: Array<{
    action: 'fix_now' | 'needs_you' ;
    code: string;
    severity: string;
    message: string;
    plugins: readonly string[];
    rounds_unresolved: number;
  }>;
  summary: string;
} {
  const newCount = outcome.forUser.filter((item) => item.disposition === 'new').length;
  const escalatedCount = outcome.forUser.filter((item) => item.disposition === 'escalate').length;
  const unresolvedCount = outcome.forUser.filter((item) => item.disposition === 'unresolved').length;

  const items = outcome.forUser.map((item) => ({
    action: (item.disposition === 'escalate' ? 'needs_you' : 'fix_now') as 'fix_now' | 'needs_you',
    code: item.code,
    severity: item.severity,
    message: item.message,
    plugins: item.plugins,
    rounds_unresolved: item.roundsUnresolved,
  }));

  const parts: string[] = [];
  if (newCount > 0) parts.push(`${newCount} 个新问题（已通报对方插件）`);
  if (escalatedCount > 0) {
    parts.push(`${escalatedCount} 个已连续 ${escalateAfter} 轮未修复（对方未处理，需你介入）`);
  }
  if (outcome.resolved.length > 0) parts.push(`${outcome.resolved.length} 个已修复`);

  return {
    new_count: newCount,
    escalated_count: escalatedCount,
    unresolved_count: unresolvedCount,
    resolved_count: outcome.resolved.length,
    notified_plugins: outcome.notifiedPlugins,
    items,
    summary: parts.length === 0 ? '无新问题' : parts.join('；'),
  };
}
