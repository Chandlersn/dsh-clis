/**
 * 系统级硬约束的数字面。
 * 上限写在契约里，避免四个插件各写一个"差不多"的数而彼此不自洽。
 */

/** 类型判断置信度上限：任何实现都不得超过它，也绝不允许 1.0。 */
export const CONFIDENCE_CEILING = 0.9;

/** 低于此值必须标记探索模式（needs_exploration=true）。 */
export const EXPLORATION_THRESHOLD = 0.7;

/** 嵌套递归深度上限的缺省值与硬上限。 */
export const DEFAULT_MAX_DEPTH = 3;
export const MAX_DEPTH_LIMIT = 8;

/** 回退次数上限（由 orchestrator 执行，此处只固化数字）。 */
export const ROLLBACK_LIMIT = 3;

/** 同一类型连续被回退后，至少锁定 N 轮才允许再次回退。 */
export const TYPE_LOCK_ROUNDS = 1;

/** 置信度归一到 [0, CONFIDENCE_CEILING]，并保留两位小数以保证可复现。 */
export function normalizeConfidence(value: number): number {
  const bounded = Math.min(Math.max(value, 0), CONFIDENCE_CEILING);
  return Math.round(bounded * 100) / 100;
}