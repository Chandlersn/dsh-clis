/**
 * 策略边界（orchestrator 交给 strategy 的约束面）。
 *
 * 本契约是硬约束「不执行 boundary.forbidden_actions 中的动作」的落地形态：
 * 黑名单是**必需**字段，白名单可选；两者同时命中时以黑名单为准（安全优先）。
 */
export interface StrategyBoundary {
  /** 禁止执行的动作名。strategy 不得把它交给执行器。 */
  readonly forbidden_actions: readonly string[];
  /** 可选白名单：存在时，不在名单内的动作同样不许执行。 */
  readonly allowed_actions?: readonly string[];
}

/** 一个动作被边界挡下的原因。 */
export type BlockedActionReason = 'forbidden' | 'not_in_allowlist';

export interface BlockedAction {
  readonly action: string;
  readonly reason: BlockedActionReason;
}

/**
 * 判定单个动作是否被边界阻断。
 *
 * @param action — 动作名。
 * @param boundary — 边界。
 * @returns 阻断原因；未被阻断时返回 `null`。
 */
export function blockedReason(
  action: string,
  boundary: StrategyBoundary,
): BlockedActionReason | null {
  if (boundary.forbidden_actions.includes(action)) return 'forbidden';
  if (boundary.allowed_actions !== undefined && !boundary.allowed_actions.includes(action)) {
    return 'not_in_allowlist';
  }
  return null;
}