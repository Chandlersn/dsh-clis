import type { CausalType, KnownCausalType } from './causal-type';
import type { ExecutionResult } from './strategy';

/** feedback 只读取分类结论里这几个字段，避免耦合整个结构。 */
export interface CausalClassificationRef {
  readonly causal_type: CausalType;
  readonly confidence: number;
  readonly sub_modules?: readonly { readonly name: string }[];
}

/**
 * 反馈信号类型。
 *
 * - effective：结果符合成功标准。
 * - ineffective：结果偏离，但因果类型假设仍成立。
 * - type_misjudged：结果反复偏离，且偏离模式与当前类型假设矛盾。
 * - boundary_invalid：优化超出预设边界。
 */
export const FEEDBACK_SIGNAL_TYPES = [
  'effective',
  'ineffective',
  'type_misjudged',
  'boundary_invalid',
] as const;

export type FeedbackSignalType = (typeof FEEDBACK_SIGNAL_TYPES)[number];

/**
 * 回退动作的种类 —— orchestrator 靠它区分"换成另一个类型再试"与"回到原类型"。
 *
 * 任务书里有两条规则的语义不同：
 * - 假设 unidirectional 但无效 → 回退**检查** cyclic（换一种假设）
 * - 假设 structural_duality 但引入反馈后失稳 → **回到** structural_duality（撤销这次误改）
 * 若只给 target_type，这两种就无法区分。
 */
export const ROLLBACK_KINDS = ['recheck_type', 'restore_type'] as const;

export type RollbackKind = (typeof ROLLBACK_KINDS)[number];

/** 回退建议。**只是建议**：feedback 不执行、不修改任何系统状态。 */
export interface SuggestedRollback {
  readonly kind: RollbackKind;
  /** 建议检查或恢复到的类型。 */
  readonly target_type: KnownCausalType;
  /** 一句话理由（≤120 字）。 */
  readonly rationale: string;
}

/** 一条反馈证据。statement 绝不允许为空。 */
export interface FeedbackEvidence {
  /** 触发该证据的规则 id。 */
  readonly rule_id: string;
  /** 人类可读的一句话证据。 */
  readonly statement: string;
}

/** feedback 的唯一输出结构。 */
export interface FeedbackSignal {
  readonly signal_type: FeedbackSignalType;
  /** 一句话说明为什么是这个信号（恒非空）。 */
  readonly reason: string;
  /** 证据链（恒非空，每条 statement 非空）。 */
  readonly evidence: readonly FeedbackEvidence[];
  /** 回退建议；无建议时不存在（不是 null）。 */
  readonly suggested_rollback?: SuggestedRollback;
  /** 做出判断时所依据的类型假设（原样回显，便于 orchestrator 审计）。 */
  readonly assumed_type: CausalType;
}

/** detect 的输入。 */
export interface FeedbackRequest {
  /** 策略执行的结果。feedback 不重新执行、不调用 classifier。 */
  readonly result: ExecutionResult;
  /** 当前类型假设。**只读**：用于比对，不用于重新分类。 */
  readonly classification: CausalClassificationRef;
  /** 预设边界：用于判定 boundary_invalid。 */
  readonly boundary: FeedbackBoundary;
}

/** feedback 只读取分类结论里这几个字段，避免耦合整个结构。 */
export interface CausalClassificationRef {
  readonly causal_type: CausalType;
  readonly confidence: number;
  readonly sub_modules?: readonly { readonly name: string }[];
}

/**
 * feedback 对边界的视角：除了黑名单/白名单，还要能判断"优化是否越界"。
 *
 * `max_rounds` 与 `success_criteria` 是 feedback 判定 effective / boundary_invalid 的依据。
 */
export interface FeedbackBoundary {
  readonly forbidden_actions: readonly string[];
  readonly allowed_actions?: readonly string[];
  /** 允许的连续干预轮数上限；超出即视为优化越界。 */
  readonly max_rounds?: number;
  /** 成功标准：要求所有步骤都 ok（缺省 true）。 */
  readonly require_all_ok?: boolean;
}

/**
 * 历史轨迹：判定"反复偏离"需要跨轮记忆，而 feedback 自身无状态
 * （不修改系统状态），故由调用方把历史传入。
 */
export interface FeedbackHistory {
  /** 同一条路径此前各轮的 signal_type，按时间顺序。 */
  readonly previous_signals: readonly FeedbackSignalType[];
  /** 同一类型假设已被回退过的次数。 */
  readonly rollback_count?: number;
}

/** detect 的可选参数。 */
export interface DetectOptions {
  /** 历史轨迹；缺省视为无历史。 */
  readonly history?: FeedbackHistory;
}