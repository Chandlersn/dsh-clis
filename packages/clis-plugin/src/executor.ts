/**
 * 半自动执行器：区分**只读观测**与**写操作**，只自动执行前者。
 *
 * 为什么这样分级（用户明确选择"半自动型"）：
 * CLIS 的价值在于"先辨明因果结构再动手"，但它不该擅自改用户的系统。
 * 于是把 27 个动作按副作用分成两类：
 * - **只读（read）**：测量、追溯、枚举、定位、排序、抽取定义 —— 不改任何状态，
 *   自动执行，拿真实观测结果回来喂反馈，这才是"半自动"的实际收益。
 * - **写（write）**：施加干预、调参、注入阻尼、改延迟、覆盖旧因 ——
 *   一律**不自动执行**，只回执 `pending_approval` 并说明需要什么授权。
 *
 * 这样做的实际效果：
 * 1. 只读阶段就能发现"这个假设站不住"（比如追溯上游发现根本不是链式）；
 * 2. 写操作始终留在人手里，不存在"CLIS 悄悄改了配置"的可能；
 * 3. 观测结果真实进入执行信号，反馈不再靠桩骗自己。
 */

import type {
  ActionExecutor,
  ActionInvocation,
  ActionResult,
} from '@clis/clis-contracts';

/** 动作的副作用等级。 */
export type ActionSideEffect = 'read' | 'write';

/**
 * 全部策略动作的副作用分级。
 *
 * 分级原则：**会不会改变被观测系统本身**。
 * - 测量/追溯/枚举/定位/排序/抽取/确认：读；
 * - 施加/调整/注入/限幅/改变/设计/执行干预：写。
 *
 * 未列出的动作一律按 `unknown` 处理并**拒绝自动执行**（fail-closed）：
 * 宁可少做一个动作，也不猜它有没有副作用。
 */
export const ACTION_SIDE_EFFECTS: Readonly<Record<string, ActionSideEffect>> = {
  // —— 只读：观测与解析 ——
  measure_loop_delay: 'read',
  measure_loop_gain: 'read',
  measure_relation_parameters: 'read',
  trace_upstream: 'read',
  enumerate_conditions: 'read',
  test_necessity: 'read',
  map_feedback_loop: 'read',
  rank_leverage_points: 'read',
  identify_poles: 'read',
  extract_definitions: 'read',
  confirm_irreversibility: 'read',
  probe_environment: 'read',
  partition_sub_modules: 'read',
  observe_response: 'read',
  select_upstream_intervention: 'read',
  design_overlay_cause: 'read',
  accept_and_plan_around: 'read',

  // —— 写：会改变系统 ——
  apply_intervention: 'write',
  intervene_at_leverage_point: 'write',
  apply_overlay: 'write',
  apply_symmetric_adjustment: 'write',
  tune_relation_parameter: 'write',
  resolve_definition_conflict: 'write',
  enforce_condition: 'write',
  inject_damping: 'write',
  limit_gain: 'write',
  shift_delay: 'write',
};

/** 写动作的回执里用的状态说明。 */
export const PENDING_APPROVAL = 'pending_approval';

/**
 * 只读动作的观测实现。
 *
 * 这些函数**不做真实 I/O**：CLIS 不知道用户的系统长什么样。
 * 它们返回"这一步需要什么观测数据"的说明，由调用方（agent）去采集后回填。
 *
 * 为什么不在插件里真的去读：不同问题对应完全不同的系统（数据库、配置、
 * 业务指标），插件没有也不该有那些访问权。半自动的正确边界是：
 * CLIS 说"这一步该观测 X"，agent 去观测，把结果回填。
 *
 * **`observationOnly: true` 是必须的**：只读动作没有改动任何东西。
 * 若不标这个字段，strategy 会把它记成 `observed`，整条路径因
 * "全部 observed" 被判 succeeded → 反馈判 effective → 编排器以为
 * 有进展而不换路径，闭环空转到回退上限（实测空转 13 轮）。
 *
 * @param invocation 动作调用。
 * @returns 观测请求说明。
 */
function observeInstruction(invocation: ActionInvocation): ActionResult {
  return {
    status: 'ok',
    observationOnly: true,
    detail: `只读观测：${invocation.action}（参数 ${JSON.stringify(invocation.params)}）—— 需采集实际数据后回填`,
  };
}

/**
 * 半自动执行器。
 *
 * 只读动作立即执行并返回观测请求；写动作一律拒绝并说明需要授权。
 */
export class SemiAutoExecutor implements ActionExecutor {
  /** 本次执行中请求过的观测动作（供回执展示）。 */
  readonly observations: string[] = [];

  /** 被拦下的写动作。 */
  readonly pendingWrites: string[] = [];

  /**
   * @param options.allowWrites 显式放行的写动作白名单；缺省为空（全部拦下）。
   */
  constructor(
    private readonly options: {
      readonly allowWrites?: readonly string[];
    } = {},
  ) {}

  /**
   * 执行一个动作：只读放行，写动作拦下等授权。
   *
   * @param invocation 动作调用。
   * @returns 动作回执。
   */
  async execute(invocation: ActionInvocation): Promise<ActionResult> {
    const level = ACTION_SIDE_EFFECTS[invocation.action];

    // 未分级动作：fail-closed，绝不猜
    if (level === undefined) {
      this.pendingWrites.push(invocation.action);
      return {
        status: 'failed',
        detail: `动作 ${invocation.action} 未分级，为安全起见不自动执行（需人工确认是否只读）`,
      };
    }

    if (level === 'read') {
      this.observations.push(invocation.action);
      return observeInstruction(invocation);
    }

    // 写动作：只有显式列入白名单才执行
    if (this.options.allowWrites?.includes(invocation.action) === true) {
      return {
        status: 'ok',
        detail: `已放行写动作 ${invocation.action}（在你的白名单内）`,
      };
    }

    this.pendingWrites.push(invocation.action);
    return {
      status: 'failed',
      detail: `写动作 ${invocation.action} 需授权：它会产生真实副作用，本次未执行（状态 ${PENDING_APPROVAL}）`,
    };
  }
}

/**
 * 判断一个动作是否会改系统。
 *
 * @param action 动作名。
 * @returns 分级；未分级返回 undefined。
 */
export function sideEffectOf(action: string): ActionSideEffect | undefined {
  return ACTION_SIDE_EFFECTS[action];
}
