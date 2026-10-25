/**
 * 系统级硬约束的数字面，以及全局唯一的两位小数归一。
 * 上限与归一都写在契约里，避免四个插件各写一个"差不多"的数或各写一套取整。
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

/**
 * 两位小数归一：先夹到 [min, max]，再按 `+1e-9` 抗浮点噪声后取整。
 *
 * `+1e-9` 不是可有可无的：形如 0.875 的分量组合在双精度下可能存成
 * 87.49999999999999，直接 `Math.round` 会得到 0.87 而非 0.88 —— 那会让
 * "实现算 0.87、验收算 0.88"这类分歧以随机方式出现，且极难复现。
 * 补偿量比双精度噪声大约 5 个数量级、又远小于 1e-2，
 * 因此只能修正噪声，不会改变任何一个真正的两位小数结果。
 *
 * @param value — 原始值。
 * @param min — 下限。
 * @param max — 上限。
 * @returns 归一后的两位小数。
 */
function roundTo2(value: number, min: number, max: number): number {
  const bounded = Math.min(Math.max(value, min), max);
  return Math.round(bounded * 100 + 1e-9) / 100;
}

/** 置信度归一到 [0, CONFIDENCE_CEILING]，保留两位小数。 */
export function normalizeConfidence(value: number): number {
  return roundTo2(value, 0, CONFIDENCE_CEILING);
}

/** 排序分归一到 [0, 1]，保留两位小数。 */
export function normalizeScore(value: number): number {
  return roundTo2(value, 0, 1);
}