import type { BlockedAction, StrategyBoundary } from './boundary';
import type { CausalType, KnownCausalType } from './causal-type';
import { normalizeScore } from './limits';

/**
 * 策略家族：一个因果类型对应一族处理方式。
 * 家族是"怎么处理"的骨架；变体是同一家族下可排序、可版本化的具体做法。
 */
export const STRATEGY_FAMILIES = [
  'duality_pairing',
  'loop_damping',
  'single_lever',
  'decompose',
  'probe_and_observe',
] as const;

export type StrategyFamily = (typeof STRATEGY_FAMILIES)[number];

/** 四种确定类型到家族的固定映射。unknown 不在此表，它走探索家族。 */
export const FAMILY_BY_TYPE: Readonly<Record<KnownCausalType, StrategyFamily>> = {
  structural_duality: 'duality_pairing',
  cyclic: 'loop_damping',
  unidirectional: 'single_lever',
  nested: 'decompose',
};

/** unknown（以及低置信度时追加的探索候选）使用的家族。 */
export const PROBE_FAMILY: StrategyFamily = 'probe_and_observe';

/**
 * 策略库的变体标识。命名规则：`<家族简称>.<做法>`，全小写下划线。
 * 变体是排序的对象；家族不是。
 */
export const PATH_VARIANTS = [
  // structural_duality
  'duality.symmetric_mapping',
  'duality.relation_tuning',
  'duality.definition_clarification',
  // cyclic
  'loop.leverage_point',
  'loop.delay_tuning',
  'loop.gain_control',
  'loop.damping_injection',
  // unidirectional
  'lever.upstream_trace',
  'lever.necessary_condition',
  'lever.new_causal_overlay',
  'lever.irreversibility_acceptance',
  // nested
  'decompose.compose_sub',
  // unknown / 探索
  'probe.minimal',
  'probe.broad',
] as const;

export type PathVariantId = (typeof PATH_VARIANTS)[number];

/**
 * 排序公式的四个分量权重。
 *
 * 每个分量都在 [0, 1] 且**越大越好**；其中"副作用风险"与"执行成本"以
 * `(1 - 值)` 进入公式 —— 即风险越低、成本越低，得分越高。
 * 四个权重之和恰为 1，因此 score 天然落在 [0, 1]。
 */
export const PATH_SCORE_WEIGHTS = {
  /** 类型匹配度：该路径的做法是否正对该类型。 */
  type_fit: 0.4,
  /** 预期效果。 */
  expected_effect: 0.3,
  /** 副作用风险（以安全性 1-risk 进入）。 */
  side_effect_risk: 0.2,
  /** 执行成本（以效率 1-cost 进入）。 */
  execution_cost: 0.1,
} as const;

/** 排序分的四个分量，逐项暴露以便复核与断言。 */
export interface PathScoreComponents {
  readonly type_fit: number;
  readonly expected_effect: number;
  readonly side_effect_risk: number;
  readonly execution_cost: number;
}

/**
 * 由分量算排序分 —— **契约里的唯一实现**，实现方与验收方共用，
 * 避免"公式一处、代码一处"再次各算各的。
 *
 * @param components — 四个分量，各自 [0, 1]。
 * @returns score，[0, 1]，两位小数。
 */
export function scorePath(components: PathScoreComponents): number {
  const raw =
    PATH_SCORE_WEIGHTS.type_fit * components.type_fit +
    PATH_SCORE_WEIGHTS.expected_effect * components.expected_effect +
    PATH_SCORE_WEIGHTS.side_effect_risk * (1 - components.side_effect_risk) +
    PATH_SCORE_WEIGHTS.execution_cost * (1 - components.execution_cost);
  return normalizeScore(raw);
}

/** 路径上的一步。参数化动作，不是自然语言忠告。 */
export interface PathStep {
  readonly index: number;
  /** 动作名，必须取自策略库声明的动作集合。 */
  readonly action: string;
  /** 动作参数。无参动作也必须是对象（可为空对象），保证"参数化"可机器检查。 */
  readonly params: Readonly<Record<string, unknown>>;
  /** 一句话说明这一步在做什么（≤60 字），不是建议。 */
  readonly rationale: string;
}

/** 一条候选路径。 */
export interface CandidatePath {
  readonly path_id: string;
  readonly variant: PathVariantId;
  /** 该变体在策略库中的版本。 */
  readonly variant_version: string;
  /** 生成该路径的策略库版本。 */
  readonly library_version: string;
  readonly family: StrategyFamily;
  /** 该路径针对的因果类型；嵌套子路径携带子模块自己的类型。 */
  readonly causal_type: CausalType;
  /**
   * 路径步骤。**绝不含被 boundary 阻断的动作** —— 被剔除的动作记录在
   * `blocked_actions` 里以备审计。
   */
  readonly steps: readonly PathStep[];
  /** 因边界而被剔除的动作；非空即 `executable === false`。 */
  readonly blocked_actions: readonly BlockedAction[];
  readonly executable: boolean;
  readonly components: PathScoreComponents;
  /** 由 components 经 scorePath() 算出，[0, 1]。 */
  readonly score: number;
  /** 同级（同一父路径下）的排序名次，从 1 起；**只由 score 决定**。 */
  readonly rank: number;
  /** 一句话说明这条路径预期达成什么（≤80 字）。 */
  readonly summary: string;
  /** 仅 decompose 家族出现：每个子模块一条子路径。 */
  readonly sub_paths?: readonly CandidatePath[];
}

/** match 的可选参数。 */
export interface StrategyMatchOptions {
  /** decompose 递归深度上限（整数 0..MAX_DEPTH_LIMIT）；缺省 DEFAULT_MAX_DEPTH。 */
  readonly max_depth?: number;
}

/** 交给执行器的一次动作调用。 */
export interface ActionInvocation {
  readonly path_id: string;
  readonly step_index: number;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export const ACTION_RESULT_STATUSES = ['ok', 'failed'] as const;
export type ActionResultStatus = (typeof ACTION_RESULT_STATUSES)[number];

/** 执行器对一次调用的回执。 */
export interface ActionResult {
  readonly status: ActionResultStatus;
  readonly detail: string;
  /**
   * true 表示这次调用**只完成了观测/读取，没有改动任何东西**。
   *
   * 语义区分（很重要）：
   * - `status: 'ok'` 且 `observationOnly` 未设 → 真的做成了一件事；
   * - `status: 'ok'` 且 `observationOnly: true` → 看清了，但系统未变。
   *
   * 半自动执行器把只读动作（measure/trace/enumerate…）标为后者，
   * 让 strategy 产出 `observed_only` 信号、反馈判 `ineffective` 而非
   * `effective` —— 否则闭环会误以为问题有进展而空转。
   */
  readonly observationOnly?: boolean;
}

/**
 * 动作执行器：由调用方（orchestrator / 宿主）提供，**不是** CLIS 插件。
 * strategy 只负责"调它"，不负责"副作用怎么实现"。
 */
export interface ActionExecutor {
  execute(invocation: ActionInvocation): Promise<ActionResult>;
}

/** 执行信号的种类。 */
export const EXECUTION_SIGNAL_KINDS = [
  'observed',
  'failed',
  /**
   * 只读观测完成，但**没有产生任何实际改动**。
   *
   * 为什么需要它（2026-10-26 真实使用发现）：
   * 半自动执行器下，只读动作（测量/追溯/枚举/定位）返回 ok，写动作被拦下。
   * 若把只读动作记成 `observed`，整条路径因「全部 observed」被判 `succeeded`
   * → 反馈判 `effective` → 编排器认为有进展、不换路径 ——
   * 实际上系统里什么也没变，闭环会空转到回退上限（实测空转 13 轮）。
   *
   * 这个信号明确表达「看清了，但还没动手」，让反馈能区分
   * "路径执行完了"与"问题有进展了"。
   */
  'observed_only',
  'skipped_forbidden',
  'not_attempted',
  'summary',
] as const;

export type ExecutionSignalKind = (typeof EXECUTION_SIGNAL_KINDS)[number];

/** 一条执行信号：逐步记录发生了什么，供 feedback 读取（strategy 不做回退判断）。 */
export interface ExecutionSignal {
  readonly path_id: string;
  /** 对应步骤下标；非步骤级的汇总信号用 -1。 */
  readonly step_index: number;
  /** 动作名；汇总信号用 'summary'。 */
  readonly action: string;
  readonly kind: ExecutionSignalKind;
  readonly detail: string;
}

export const EXECUTION_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * 一次路径执行的结论。
 * 注意：**不含任何回退决策字段** —— 回退由 orchestrator 决定。
 */
export interface ExecutionResult {
  readonly path_id: string;
  readonly status: ExecutionStatus;
  /** 执行信号，恒非空，末条恒为 `kind: 'summary'`。 */
  readonly signals: readonly ExecutionSignal[];
  readonly blocked_actions: readonly BlockedAction[];
  /** 仅 decompose 家族出现：每个子路径一份结果。 */
  readonly sub_results?: readonly ExecutionResult[];
}

/**
 * execute 的依赖。
 *
 * 任务书写的是 `execute(path)`；边界与执行器是它不可省的两个依赖，
 * 又都不是插件自身能提供的，故显式作为第二参传入，而不是藏进状态或注入。
 */
export interface ExecutePathOptions {
  readonly boundary: StrategyBoundary;
  readonly executor: ActionExecutor;
}