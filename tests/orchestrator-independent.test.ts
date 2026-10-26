/**
 * clis-orchestrator 独立验收套件（黑盒，验证方所有）。
 *
 * 判据唯一来源：`docs/SPEC-orchestrator.md`（状态 FROZEN）。
 * 本套件**不读实现**：只从 `packages/clis-orchestrator/src/index.ts` 取导出名，
 * 所有断言均由规格逐条推导；每条断言在注释里标注规格小节，
 * 失败时可直接分辨"实现错了"还是"规格理解错了"。
 *
 * 覆盖（对应任务书 1–6，并额外含 §2 公开面与 §6.6 结构检查）：
 * - §3.1 回退计数与上限（含"不可达的四轮连续回退"陷阱，按 §3.1 的五轮表断言）
 * - §3.2/§3.4/§3.6 震荡锁定的触发条件、锁定期行为与清零
 * - §3.3–§3.7 各信号类型对应的决策动作与优先级
 * - §4/§2.1 trace 字段与不变量（每轮一条、note 非空、人工介入时仍追加）
 * - §4 状态更新不可变性（深冻结 + 深快照 + 确定性）
 * - §5 畸形输入的错误码
 *
 * 关于 `decide` 的导入方式：规格 §2 声明它是**同步**纯函数
 * `(round, state, options?) => { decision, nextState }`，而契约里的
 * `OrchestratorService.decide` 是 Promise。为了把"同步/异步不符"变成一条
 * 运行期断言（而不是让 tsc 直接编译失败），这里对 `decide` 做一次窄化 cast，
 * 参数保持宽松（畸形输入需要它），同步性由 decideOnce() 显式断言（SPEC §2）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import type {
  ActionExecutor,
  CandidatePath,
  CausalProblem,
  CausalType,
  ClisContractErrorCode,
  ExecutionResult,
  FeedbackSignal,
  FeedbackSignalType,
  OrchestratorAction,
  OrchestratorDecision,
  OrchestratorOptions,
  OrchestratorRound,
  OrchestratorState,
  RoundTrace,
  StrategyBoundary,
  SuggestedRollback,
} from '@clis/clis-contracts';
import {
  CAUSAL_ORCHESTRATOR_SERVICE,
  ClisContractError,
  ROLLBACK_LIMIT,
  RUN_OUTCOMES,
  TYPE_LOCK_ROUNDS,
  initialState,
} from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';
import {
  ROLLBACK_LIMIT_DEFAULT,
  TYPE_LOCK_ROUNDS_DEFAULT,
  decide,
} from '@clis/clis-orchestrator';

// ─────────────────────────────────────────────────────────────
// 0. 基础设施（构造数据 + 调用夹具）
// ─────────────────────────────────────────────────────────────

type DecideFn = (round: unknown, state: unknown, options?: unknown) => unknown;

const decideAny = decide as unknown as DecideFn;

/** 取下标，越界即报错（兼容 noUncheckedIndexedAccess 的严格配置）。 */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`验收套件内部错误：下标 ${index} 越界（长度 ${values.length}）`);
  }
  return value;
}

/**
 * 调用 `decide`，并显式断言规格 §2 的"同步纯函数"要求。
 * 返回 Promise/thenable 视为规格违背（并能让后续断言给出可读的诊断）。
 */
function decideOnce(
  round: OrchestratorRound,
  state: OrchestratorState,
  options?: OrchestratorOptions,
): { decision: OrchestratorDecision; nextState: OrchestratorState } {
  const output = decideAny(round, state, options);
  if (output === null || typeof output !== 'object') {
    throw new Error('SPEC §2：decide 必须返回 { decision, nextState }');
  }
  if (typeof (output as { then?: unknown }).then === 'function') {
    throw new Error('SPEC §2：decide 声明为同步纯函数，实际返回了 Promise/thenable');
  }
  return output as { decision: OrchestratorDecision; nextState: OrchestratorState };
}

/** 断言某次调用抛指定 code 的 ClisContractError，且**没有**返回兜底决策（SPEC §5）。 */
function expectThrownCode(call: () => unknown, code: ClisContractErrorCode): void {
  let thrown: unknown;
  let returned = false;
  try {
    call();
    returned = true;
  } catch (error) {
    thrown = error;
  }
  expect(returned, 'SPEC §5：畸形输入必须抛错，绝不返回兜底决策').toBe(false);
  expect(thrown, `SPEC §5：期望抛 code=${code} 的 ClisContractError`).toBeInstanceOf(
    ClisContractError,
  );
  expect((thrown as ClisContractError).code).toBe(code);
}

const PROBLEM: CausalProblem = {
  description: '验收套件构造的问题（decide 不依赖它做判断）',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'yes',
    q4_coexisting_causal_structures: 'no',
  },
};

const BOUNDARY: StrategyBoundary = { forbidden_actions: [] };

const RECHECK_ROLLBACK: SuggestedRollback = {
  kind: 'recheck_type',
  target_type: 'cyclic',
  rationale: '验收构造：换一种假设再试',
};

const RESTORE_ROLLBACK: SuggestedRollback = {
  kind: 'restore_type',
  target_type: 'structural_duality',
  rationale: '验收构造：回到原类型',
};

function makePath(pathId = 'p1', causalType: CausalType = 'unidirectional'): CandidatePath {
  return {
    path_id: pathId,
    variant: 'lever.upstream_trace',
    variant_version: '1.0.0',
    library_version: '1.0.0',
    family: 'single_lever',
    causal_type: causalType,
    steps: [],
    blocked_actions: [],
    executable: true,
    components: { type_fit: 1, expected_effect: 1, side_effect_risk: 0, execution_cost: 0 },
    score: 1,
    rank: 1,
    summary: '验收构造路径',
  };
}

function makeExecution(
  status: ExecutionResult['status'] = 'succeeded',
  pathId = 'p1',
): ExecutionResult {
  return {
    path_id: pathId,
    status,
    signals: [
      { path_id: pathId, step_index: -1, action: 'summary', kind: 'summary', detail: '验收构造' },
    ],
    blocked_actions: [],
  };
}

function makeSignal(
  signalType: FeedbackSignalType,
  extra: { assumed_type?: CausalType; suggested_rollback?: SuggestedRollback } = {},
): FeedbackSignal {
  return {
    signal_type: signalType,
    reason: '验收构造：信号仅用于驱动决策',
    evidence: [{ rule_id: 'ACCEPTANCE', statement: '验收构造的证据' }],
    assumed_type: extra.assumed_type ?? 'unidirectional',
    ...(extra.suggested_rollback !== undefined
      ? { suggested_rollback: extra.suggested_rollback }
      : {}),
  };
}

function makeRound(
  input: {
    signal_type?: FeedbackSignalType;
    causal_type?: CausalType;
    signal?: FeedbackSignal;
    path?: CandidatePath;
    execution?: ExecutionResult;
  } = {},
): OrchestratorRound {
  const signal = input.signal ?? makeSignal(input.signal_type ?? 'effective');
  return {
    problem: PROBLEM,
    boundary: BOUNDARY,
    path: input.path ?? makePath(),
    execution: input.execution ?? makeExecution(),
    signal,
    causal_type: input.causal_type ?? signal.assumed_type,
  };
}

function makeState(
  input: {
    round?: number;
    rollback_count?: number;
    lock_remaining?: number;
    locked_type?: CausalType;
    consecutive?: Readonly<Record<string, number>>;
    traces?: readonly RoundTrace[];
  } = {},
): OrchestratorState {
  return {
    round: input.round ?? 0,
    rollback_count: input.rollback_count ?? 0,
    oscillation: {
      consecutive_rollbacks: input.consecutive ?? {},
      ...(input.locked_type !== undefined ? { locked_type: input.locked_type } : {}),
      lock_remaining: input.lock_remaining ?? 0,
    },
    traces: input.traces ?? [],
  };
}

function makeTrace(round: number, note = `历史 trace 第 ${round} 轮`): RoundTrace {
  return {
    round,
    causal_type: 'unidirectional',
    path_id: 'p1',
    execution_status: 'succeeded',
    signal_type: 'effective',
    action: 'continue',
    rollback_count: 0,
    note,
  };
}

interface PlannedRound {
  readonly signal_type: FeedbackSignalType;
  readonly causal_type?: CausalType;
}

interface PlanRun {
  readonly actions: readonly OrchestratorAction[];
  /** 每轮决策后的 rollback_count。 */
  readonly rollbackCounts: readonly number[];
  readonly decisions: readonly OrchestratorDecision[];
  /** 含初始态：states[0] 是入参 state，states[i] 是第 i 轮之后。 */
  readonly states: readonly OrchestratorState[];
  readonly traces: readonly RoundTrace[];
  readonly final: OrchestratorState;
}

/** 按计划逐轮调用 decide 并串联 nextState（规格 §2：状态由调用方持有）。 */
function runPlan(
  plan: readonly PlannedRound[],
  options?: OrchestratorOptions,
  start?: OrchestratorState,
): PlanRun {
  let state = start ?? initialState();
  const actions: OrchestratorAction[] = [];
  const rollbackCounts: number[] = [];
  const decisions: OrchestratorDecision[] = [];
  const states: OrchestratorState[] = [state];
  const traces: RoundTrace[] = [];
  for (const planned of plan) {
    const { decision, nextState } = decideOnce(makeRound(planned), state, options);
    actions.push(decision.action);
    rollbackCounts.push(decision.rollback_count);
    decisions.push(decision);
    state = nextState;
    states.push(state);
    traces.push(at(state.traces, state.traces.length - 1));
  }
  return { actions, rollbackCounts, decisions, states, traces, final: state };
}

const ROLLBACK_SIGNALS: readonly FeedbackSignalType[] = [
  'type_misjudged',
  'ineffective',
  'boundary_invalid',
];

function repeatPattern(pattern: readonly FeedbackSignalType[], times: number): PlannedRound[] {
  const plan: PlannedRound[] = [];
  for (let index = 0; index < times; index += 1) {
    const signalType = pattern[index % pattern.length];
    if (signalType !== undefined) plan.push({ signal_type: signalType, causal_type: 'unidirectional' });
  }
  return plan;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
    Object.freeze(value);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────
// A. SPEC §2 公开面（逐字匹配）
// ─────────────────────────────────────────────────────────────

describe('SPEC §2 公开面', () => {
  it('name 逐字为 clis-orchestrator', () => {
    // SPEC §2
    expect(orchestratorPlugin.name).toBe('clis-orchestrator');
  });

  it('inject 恰为三个服务名，顺序与规格一致', () => {
    // SPEC §2 + §6.6「inject 恰为三个服务名」
    expect(orchestratorPlugin.inject).toEqual([
      'clis.causalClassifier',
      'clis.causalStrategy',
      'clis.causalFeedback',
    ]);
    expect(orchestratorPlugin.inject).toHaveLength(3);
  });

  it('ROLLBACK_LIMIT_DEFAULT 为 3，且与契约常量一致', () => {
    // SPEC §2 + §3.1（缺省 3）
    expect(ROLLBACK_LIMIT_DEFAULT).toBe(3);
    expect(ROLLBACK_LIMIT_DEFAULT).toBe(ROLLBACK_LIMIT);
  });

  it('TYPE_LOCK_ROUNDS_DEFAULT 为 1，且与契约常量一致', () => {
    // SPEC §2 + §3.4（缺省 1）
    expect(TYPE_LOCK_ROUNDS_DEFAULT).toBe(1);
    expect(TYPE_LOCK_ROUNDS_DEFAULT).toBe(TYPE_LOCK_ROUNDS);
  });

  it('导出形状：decide / apply / OrchestratorServiceImpl 均为函数', () => {
    // SPEC §2（公开面表格）
    expect(typeof decide).toBe('function');
    expect(typeof orchestratorPlugin.apply).toBe('function');
    expect(typeof orchestratorPlugin.OrchestratorServiceImpl).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────
// B. SPEC §3.1 人工介入与回退上限
// ─────────────────────────────────────────────────────────────

describe('SPEC §3.1 人工介入（最高优先级）与回退上限', () => {
  it('五轮真实序列是「回退、回退+锁定、锁定继续、回退、人工介入」（禁止按四轮连续回退断言）', () => {
    // SPEC §3.1 的轮次表（规格明确要求验收按此表断言）
    const run = runPlan(
      repeatPattern(['type_misjudged'], 5),
      undefined,
      initialState(),
    );
    expect(run.actions).toEqual([
      'rollback_to_classifier',
      'rollback_to_classifier',
      'lock_and_continue',
      'rollback_to_classifier',
      'manual_intervention',
    ]);
    // 初始 0 + 每轮决策后的累计值
    expect([0, ...run.rollbackCounts]).toEqual([0, 1, 2, 2, 3, 3]);
    expect(run.final.traces).toHaveLength(5);
    expect(run.final.round).toBe(5);
  });

  it('回退上限兜住总回退次数：三种类型各回退一次后即人工介入，rollback_count 不再增长', () => {
    // SPEC §3.1（回退耗尽 → manual_intervention）+ §3.4（按类型分别计数，故此处不触发锁定）
    const run = runPlan([
      { signal_type: 'type_misjudged', causal_type: 'unidirectional' },
      { signal_type: 'type_misjudged', causal_type: 'cyclic' },
      { signal_type: 'type_misjudged', causal_type: 'nested' },
      { signal_type: 'boundary_invalid', causal_type: 'unidirectional' },
      { signal_type: 'ineffective', causal_type: 'unidirectional' },
    ]);
    expect(run.actions).toEqual([
      'rollback_to_classifier',
      'rollback_to_classifier',
      'rollback_to_classifier',
      'manual_intervention',
      'manual_intervention',
    ]);
    expect(run.rollbackCounts).toEqual([1, 2, 3, 3, 3]);
    expect(run.final.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
  });

  it('12 轮混合回退：rollback_count 任何时刻都不超过上限（SPEC §6.2）', () => {
    // SPEC §4（任何情况下不得超过 rollback_limit）+ §6.2
    const run = runPlan(repeatPattern(ROLLBACK_SIGNALS, 12));
    for (const count of run.rollbackCounts) {
      expect(count).toBeLessThanOrEqual(ROLLBACK_LIMIT_DEFAULT);
    }
    expect(Math.max(...run.rollbackCounts)).toBe(ROLLBACK_LIMIT_DEFAULT);
    // 上限达到后仍在回退的信号必须转为人工介入
    expect(run.actions.slice(4).every((action) => action === 'manual_intervention')).toBe(true);
    // SPEC §4 / §6.4：trace 每轮一条、编号从 1 起连续、note 非空
    expect(run.final.traces).toHaveLength(12);
    run.final.traces.forEach((trace, index) => {
      expect(trace.round).toBe(index + 1);
      expect(trace.note.trim().length).toBeGreaterThan(0);
    });
  });

  it('已达上限 + ineffective ⇒ manual_intervention（不是 switch_path）', () => {
    // SPEC §3.1（最高优先级）
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'ineffective' }),
      makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
    );
    expect(decision.action).toBe('manual_intervention');
    expect(nextState.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
  });

  it('已达上限 + boundary_invalid ⇒ manual_intervention（不是 rollback_to_boundary）', () => {
    // SPEC §3.1（最高优先级）+ §3.3
    const { decision } = decideOnce(
      makeRound({ signal_type: 'boundary_invalid' }),
      makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
    );
    expect(decision.action).toBe('manual_intervention');
  });

  it('已达上限 + type_misjudged ⇒ manual_intervention（不是 rollback_to_classifier）', () => {
    // SPEC §3.1（最高优先级）+ §3.4
    const { decision } = decideOnce(
      makeRound({ signal_type: 'type_misjudged' }),
      makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
    );
    expect(decision.action).toBe('manual_intervention');
  });

  it('已达上限但本轮 effective ⇒ 仍 continue（§3.1 要求"本轮信号仍未解决"）', () => {
    // SPEC §3.1 条件：rc >= limit **且** 信号仍为三种未解决信号之一 ⇒ effective 不触发人工介入
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'effective' }),
      makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
    );
    expect(decision.action).toBe('continue');
    expect(nextState.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
  });

  it('manual_intervention 的 reason 必须含"需人工介入"字样', () => {
    // SPEC §3.1：「reason 必须含"需人工介入"字样」
    const { decision } = decideOnce(
      makeRound({ signal_type: 'boundary_invalid' }),
      makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
    );
    expect(decision.reason).toContain('需人工介入');
  });

  it('manual_intervention 仍追加本轮 trace（完整 trace 是硬要求）且 rollback_count 不增', () => {
    // SPEC §3.1：「nextState.traces 仍要追加本轮 trace」+「rollback_count 不增」
    const history: readonly RoundTrace[] = [makeTrace(1), makeTrace(2), makeTrace(3)];
    const state = makeState({ round: 3, rollback_count: ROLLBACK_LIMIT_DEFAULT, traces: history });
    const { decision, nextState } = decideOnce(makeRound({ signal_type: 'type_misjudged' }), state);

    expect(decision.action).toBe('manual_intervention');
    expect(decision.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
    expect(nextState.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
    expect(nextState.traces).toHaveLength(4);
    expect(at(nextState.traces, 3).action).toBe('manual_intervention');
  });

  it('自定义 rollback_limit=1：一次回退后即人工介入（options 生效，不给 rc 留出余量）', () => {
    // SPEC §2（options 形状）+ §3.1（上限可配置）
    const run = runPlan(repeatPattern(['type_misjudged'], 2), { rollback_limit: 1 });
    expect(run.actions).toEqual(['rollback_to_classifier', 'manual_intervention']);
    expect(run.rollbackCounts).toEqual([1, 1]);
  });

  it('优先级：manual_intervention 高于锁定（rc 已满 + 锁定中 + type_misjudged）', () => {
    // SPEC §3.1（最高优先级）+ §6.1（manual_intervention > 锁定）
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'type_misjudged', causal_type: 'unidirectional' }),
      makeState({
        rollback_count: ROLLBACK_LIMIT_DEFAULT,
        lock_remaining: 1,
        locked_type: 'unidirectional',
        consecutive: { unidirectional: 2 },
      }),
    );
    expect(decision.action).toBe('manual_intervention');
    expect(nextState.rollback_count).toBe(ROLLBACK_LIMIT_DEFAULT);
  });
});

// ─────────────────────────────────────────────────────────────
// C. SPEC §3.2 锁定生效（震荡保护）
// ─────────────────────────────────────────────────────────────

describe('SPEC §3.2 锁定生效（震荡保护）', () => {
  it('锁定中（信号非 effective）⇒ lock_and_continue：锁定类型透传、rollback_count 不变、剩余轮数递减', () => {
    // SPEC §3.2
    const state = makeState({
      rollback_count: 2,
      lock_remaining: 1,
      locked_type: 'cyclic',
      consecutive: { cyclic: 2 },
    });
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'type_misjudged', causal_type: 'cyclic' }),
      state,
    );
    expect(decision.action).toBe('lock_and_continue');
    expect(decision.locked_type).toBe('cyclic');
    expect(decision.rollback_count).toBe(2);
    expect(nextState.rollback_count).toBe(2);
    expect(nextState.oscillation.lock_remaining).toBe(0);
    expect(nextState.oscillation.locked_type).toBe('cyclic');
    expect(at(nextState.traces, 0).action).toBe('lock_and_continue');
  });

  it('锁定期间即使 type_misjudged 也不回退（SPEC §6 明写）', () => {
    // SPEC §6「锁定期间即使 type_misjudged 也不回退」+ §3.2「锁定期间不允许回退」
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'type_misjudged', causal_type: 'unidirectional' }),
      makeState({ rollback_count: 1, lock_remaining: 2, locked_type: 'unidirectional' }),
    );
    expect(decision.action).toBe('lock_and_continue');
    expect(nextState.rollback_count).toBe(1);
  });

  it('锁定期间 boundary_invalid 也不回退（§3.2 优先于 §3.3）', () => {
    // SPEC §3.2 + §6.1（锁定 > boundary_invalid）
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'boundary_invalid' }),
      makeState({ rollback_count: 0, lock_remaining: 1, locked_type: 'unidirectional' }),
    );
    expect(decision.action).toBe('lock_and_continue');
    expect(nextState.rollback_count).toBe(0);
  });

  it('锁定期间 ineffective 也不换路径（§3.2 优先于 §3.5）', () => {
    // SPEC §3.2 + §6.1（锁定 > switch_path）
    const { decision } = decideOnce(
      makeRound({ signal_type: 'ineffective' }),
      makeState({ lock_remaining: 1, locked_type: 'unidirectional' }),
    );
    expect(decision.action).toBe('lock_and_continue');
    expect(decision.next_path_id).toBeUndefined();
  });

  it('优先级：锁定高于兜底（未知信号类型 + 锁定中）', () => {
    // SPEC §3.2 条件「信号不是 effective」+ §6.1（锁定 > continue/兜底）
    const unknownSignal = makeSignal('mystery_signal' as FeedbackSignalType);
    const { decision } = decideOnce(
      makeRound({ signal: unknownSignal, causal_type: 'unidirectional' }),
      makeState({ lock_remaining: 1, locked_type: 'unidirectional' }),
    );
    expect(decision.action).toBe('lock_and_continue');
  });

  it('lock_rounds=2 时锁定恰好两轮：剩余数 2→1→0，之后才恢复回退', () => {
    // SPEC §3.2（上一轮 - 1）+ §3.4（lock_remaining = lock_rounds）
    const run = runPlan(repeatPattern(['type_misjudged'], 5), { lock_rounds: 2 });
    expect(run.actions).toEqual([
      'rollback_to_classifier',
      'rollback_to_classifier',
      'lock_and_continue',
      'lock_and_continue',
      'rollback_to_classifier',
    ]);
    expect(run.rollbackCounts).toEqual([1, 2, 2, 2, 3]);
    // states[0] 初始态；states[1..4] 分别对应第 1..4 轮之后
    expect(run.states.slice(0, 5).map((state) => state.oscillation.lock_remaining)).toEqual([
      0, 0, 2, 1, 0,
    ]);
  });

  it('lock_rounds=0（§5 允许非负整数）⇒ 不产生锁定效果，第三轮仍回退', () => {
    // SPEC §5（lock_rounds 为非负整数，0 合法）+ §3.4（lock_remaining = lock_rounds）+ §3.2（> 0 才锁定）
    const run = runPlan(repeatPattern(['type_misjudged'], 3), { lock_rounds: 0 });
    expect(run.actions).toEqual([
      'rollback_to_classifier',
      'rollback_to_classifier',
      'rollback_to_classifier',
    ]);
    expect(run.rollbackCounts).toEqual([1, 2, 3]);
    expect(at(run.states, 2).oscillation.lock_remaining).toBe(0);
  });

  it('锁定轮仍追加 trace（锁定不是 trace 的例外）', () => {
    // SPEC §4（每轮一条，永不丢弃）
    const { nextState } = decideOnce(
      makeRound({ signal_type: 'boundary_invalid' }),
      makeState({ round: 9, lock_remaining: 1, locked_type: 'unidirectional' }),
    );
    expect(nextState.traces).toHaveLength(1);
    expect(at(nextState.traces, 0).round).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────
// D. SPEC §3.3–§3.7 信号 → 动作映射
// ─────────────────────────────────────────────────────────────

describe('SPEC §3.3–§3.7 信号 → 动作映射', () => {
  it('boundary_invalid ⇒ rollback_to_boundary，rollback_count + 1', () => {
    // SPEC §3.3
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'boundary_invalid' }),
      makeState({ rollback_count: 0 }),
    );
    expect(decision.action).toBe('rollback_to_boundary');
    expect(decision.rollback_count).toBe(1);
    expect(nextState.rollback_count).toBe(1);
  });

  it('type_misjudged ⇒ rollback_to_classifier，rollback_count + 1', () => {
    // SPEC §3.4
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'type_misjudged' }),
      makeState({ rollback_count: 1 }),
    );
    expect(decision.action).toBe('rollback_to_classifier');
    expect(decision.rollback_count).toBe(2);
    expect(nextState.rollback_count).toBe(2);
  });

  it('retry_type 取自 suggested_rollback.target_type（kind=recheck_type）', () => {
    // SPEC §3.4
    const { decision } = decideOnce(
      makeRound({
        signal: makeSignal('type_misjudged', { suggested_rollback: RECHECK_ROLLBACK }),
      }),
      makeState(),
    );
    expect(decision.action).toBe('rollback_to_classifier');
    expect(decision.retry_type).toBe('cyclic');
  });

  it('retry_type 同样取自 kind=restore_type 的建议（§3.4 未区分 kind）', () => {
    // SPEC §3.4（字面只取 target_type；契约里 OrchestratorDecision 无 kind 字段 —— 两者张力见报告）
    const { decision } = decideOnce(
      makeRound({
        signal: makeSignal('type_misjudged', { suggested_rollback: RESTORE_ROLLBACK }),
      }),
      makeState(),
    );
    expect(decision.action).toBe('rollback_to_classifier');
    expect(decision.retry_type).toBe('structural_duality');
  });

  it('无 suggested_rollback 时 retry_type 不设（缺失即不设该字段）', () => {
    // SPEC §3.4
    const { decision } = decideOnce(
      makeRound({ signal: makeSignal('type_misjudged') }),
      makeState(),
    );
    expect(decision.retry_type).toBeUndefined();
  });

  it('ineffective ⇒ switch_path，rollback_count 不变；无 next_path_id 来源时不设该字段', () => {
    // SPEC §3.5 + §4（rc 只在 §3.3/§3.4 递增）
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'ineffective' }),
      makeState({ rollback_count: 2 }),
    );
    expect(decision.action).toBe('switch_path');
    expect(nextState.rollback_count).toBe(2);
    expect(decision.next_path_id).toBeUndefined();
  });

  it('SPEC §3.5：round 上给出 next_path_id 时应原样透传（字段已进契约）', () => {
    // SPEC §3.5「调用方在 round 里给出的 next_path_id 存在时用它」。
    //
    // 本用例原先是"与契约冲突探针"—— 当时 OrchestratorRound 未声明该字段，
    // 只能 `as` 断言绕过类型系统。验收报告提交后契约已补上该字段
    // （clis-contracts/src/orchestrator.ts），故此处不再需要断言，
    // 类型安全调用方现在能直接传进去了。
    const round = { ...makeRound({ signal_type: 'ineffective' }), next_path_id: 'p-acceptance-2' };
    const { decision } = decideOnce(round, makeState());
    expect(decision.action).toBe('switch_path');
    expect(decision.next_path_id).toBe('p-acceptance-2');
  });

  it('SPEC §3.4：suggested_rollback.kind 应原样透传为 retry_kind', () => {
    // 契约 feedback 刻意区分 recheck_type / restore_type：
    // 前者是"换一种类型假设"，后者是"回到原类型再试"。
    // 早先 OrchestratorDecision 无字段承载，这个区分在编排层断了。
    for (const kind of ['recheck_type', 'restore_type'] as const) {
      const { decision } = decideOnce(
        makeRound({
          signal: makeSignal('type_misjudged', {
            suggested_rollback: {
              target_type: 'cyclic',
              kind,
              rationale: `验收构造：建议 ${kind}`,
            },
          }),
        }),
        makeState(),
      );
      expect(decision.retry_type).toBe('cyclic');
      expect(decision.retry_kind).toBe(kind);
    }
  });

  it('SPEC §3.4：无 suggested_rollback 时 retry_kind 不设（与 retry_type 同步）', () => {
    const { decision } = decideOnce(
      makeRound({ signal_type: 'type_misjudged' }),
      makeState(),
    );
    expect(decision.retry_type).toBeUndefined();
    expect(decision.retry_kind).toBeUndefined();
  });

  it('effective ⇒ continue，rollback_count 不变', () => {
    // SPEC §3.6
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'effective' }),
      makeState({ rollback_count: 2 }),
    );
    expect(decision.action).toBe('continue');
    expect(nextState.rollback_count).toBe(2);
  });

  it('未知信号类型 ⇒ §3.7 兜底 continue，reason 说明兜底原因', () => {
    // SPEC §3.7
    const { decision, nextState } = decideOnce(
      makeRound({ signal: makeSignal('mystery_signal' as FeedbackSignalType) }),
      makeState({ rollback_count: 1 }),
    );
    expect(decision.action).toBe('continue');
    expect(decision.reason.trim().length).toBeGreaterThan(0);
    expect(nextState.rollback_count).toBe(1);
    expect(at(nextState.traces, 0).signal_type).toBe('mystery_signal');
  });

  it('六种 action 各至少一例，且 note / reason 恒非空、trace 与决策的 rollback_count 一致', () => {
    // SPEC §6（六种 action 各 ≥1 例）+ §4（reason 恒非空、RoundTrace.note 恒非空）
    const scenarios: readonly {
      expected: OrchestratorAction;
      round: OrchestratorRound;
      state: OrchestratorState;
    }[] = [
      { expected: 'continue', round: makeRound({ signal_type: 'effective' }), state: makeState() },
      { expected: 'switch_path', round: makeRound({ signal_type: 'ineffective' }), state: makeState() },
      {
        expected: 'rollback_to_classifier',
        round: makeRound({ signal_type: 'type_misjudged' }),
        state: makeState(),
      },
      {
        expected: 'rollback_to_boundary',
        round: makeRound({ signal_type: 'boundary_invalid' }),
        state: makeState(),
      },
      {
        expected: 'lock_and_continue',
        round: makeRound({ signal_type: 'type_misjudged', causal_type: 'unidirectional' }),
        state: makeState({ lock_remaining: 1, locked_type: 'unidirectional' }),
      },
      {
        expected: 'manual_intervention',
        round: makeRound({ signal_type: 'type_misjudged' }),
        state: makeState({ rollback_count: ROLLBACK_LIMIT_DEFAULT }),
      },
    ];

    const seen = new Set<OrchestratorAction>();
    for (const scenario of scenarios) {
      const { decision, nextState } = decideOnce(scenario.round, scenario.state);
      seen.add(decision.action);
      expect(decision.action).toBe(scenario.expected);

      const trace = at(nextState.traces, nextState.traces.length - 1);
      expect(trace.action).toBe(scenario.expected);
      expect(trace.note.trim().length).toBeGreaterThan(0);
      expect(decision.reason.trim().length).toBeGreaterThan(0);
      expect(trace.rollback_count).toBe(decision.rollback_count);
      expect(nextState.rollback_count).toBe(decision.rollback_count);
    }
    expect(seen.size).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────
// E. SPEC §3.4 震荡记录 / §3.6 清零
// ─────────────────────────────────────────────────────────────

describe('SPEC §3.4 震荡记录与 §3.6 清零', () => {
  it('同一类型第一次被回退 ⇒ 不锁定（计数 1）', () => {
    // SPEC §3.4（计数 +1；≥2 才锁定）
    const { nextState } = decideOnce(
      makeRound({ signal_type: 'type_misjudged', causal_type: 'unidirectional' }),
      makeState(),
    );
    expect(nextState.oscillation.consecutive_rollbacks['unidirectional']).toBe(1);
    expect(nextState.oscillation.lock_remaining).toBe(0);
    expect(nextState.oscillation.locked_type).toBeUndefined();
  });

  it('同一类型连续第二次被回退 ⇒ 锁定生效一轮，且本次仍按 rollback 执行', () => {
    // SPEC §3.4「该类型若被锁定，本次仍按 rollback 执行（锁定从下一轮生效）」
    const run = runPlan(repeatPattern(['type_misjudged'], 2));
    expect(run.actions).toEqual(['rollback_to_classifier', 'rollback_to_classifier']);
    const locked = at(run.states, 2);
    expect(locked.oscillation.locked_type).toBe('unidirectional');
    expect(locked.oscillation.lock_remaining).toBe(TYPE_LOCK_ROUNDS_DEFAULT);
    // 锁定从下一轮生效：第三轮变成 lock_and_continue 且 rc 不增
    const third = decideOnce(
      makeRound({ signal_type: 'type_misjudged', causal_type: 'unidirectional' }),
      locked,
    );
    expect(third.decision.action).toBe('lock_and_continue');
    expect(third.nextState.rollback_count).toBe(locked.rollback_count);
  });

  it('不同因果类型各回退一次 ⇒ 不锁定（按类型分别计数）', () => {
    // SPEC §3.4（按 round.causal_type 分键计数）
    const run = runPlan([
      { signal_type: 'type_misjudged', causal_type: 'unidirectional' },
      { signal_type: 'type_misjudged', causal_type: 'cyclic' },
    ]);
    expect(run.actions).toEqual(['rollback_to_classifier', 'rollback_to_classifier']);
    expect(run.states[2]?.oscillation.locked_type).toBeUndefined();
    expect(run.states[2]?.oscillation.lock_remaining).toBe(0);
  });

  it('boundary_invalid 不产生震荡记录（§3.3 无计数条款，§3.4 才有）', () => {
    // SPEC §3.3（仅 rc+1 与 action）+ §3.4（唯一规定震荡计数的条款）
    const run = runPlan(repeatPattern(['boundary_invalid'], 2));
    expect(run.actions).toEqual(['rollback_to_boundary', 'rollback_to_boundary']);
    expect(at(run.states, 2).oscillation.lock_remaining).toBe(0);
    expect(at(run.states, 2).oscillation.locked_type).toBeUndefined();
  });

  it('effective 清零该类型的连续回退计数与锁定（§3.6）', () => {
    // SPEC §3.6
    const state = makeState({
      rollback_count: 2,
      lock_remaining: 1,
      locked_type: 'unidirectional',
      consecutive: { unidirectional: 2 },
    });
    const { decision, nextState } = decideOnce(
      makeRound({ signal_type: 'effective', causal_type: 'unidirectional' }),
      state,
    );
    expect(decision.action).toBe('continue');
    expect(nextState.rollback_count).toBe(2);
    expect(nextState.oscillation.lock_remaining).toBe(0);
    expect(nextState.oscillation.locked_type).toBeUndefined();
    expect(nextState.oscillation.consecutive_rollbacks['unidirectional'] ?? 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// F. SPEC §4 状态更新不变量与 trace 完整性
// ─────────────────────────────────────────────────────────────

describe('SPEC §4 状态更新不变量与 trace 完整性', () => {
  it('nextState.round = state.round + 1，且 RoundTrace.round 与本轮编号一致（从 1 起）', () => {
    // SPEC §4
    const first = decideOnce(makeRound({ signal_type: 'effective' }), initialState());
    expect(first.nextState.round).toBe(1);
    expect(at(first.nextState.traces, 0).round).toBe(1);

    const eighth = decideOnce(
      makeRound({ signal_type: 'effective' }),
      makeState({ round: 7, traces: [makeTrace(7)] }),
    );
    expect(eighth.nextState.round).toBe(8);
    expect(at(eighth.nextState.traces, 1).round).toBe(8);
  });

  it('trace 逐项镜像本轮输入与决策（causal_type / path_id / execution_status / signal_type / action / rollback_count）', () => {
    // SPEC §4 + 契约 RoundTrace 字段定义
    const round = makeRound({
      signal_type: 'boundary_invalid',
      causal_type: 'cyclic',
      path: makePath('pZ', 'cyclic'),
      execution: makeExecution('failed', 'pZ'),
    });
    const { decision, nextState } = decideOnce(round, initialState());
    const trace = at(nextState.traces, 0);

    expect(trace.causal_type).toBe('cyclic');
    expect(trace.path_id).toBe('pZ');
    expect(trace.execution_status).toBe('failed');
    expect(trace.signal_type).toBe('boundary_invalid');
    expect(trace.action).toBe(decision.action);
    expect(trace.rollback_count).toBe(decision.rollback_count);
    expect(trace.note.trim().length).toBeGreaterThan(0);
  });

  it('nextState.traces = 旧 traces 追加一条；历史既不被丢弃也不被改写', () => {
    // SPEC §4（永不丢弃历史）
    const history: readonly RoundTrace[] = [makeTrace(1), makeTrace(2)];
    const historySnapshot = structuredClone(history);
    const { nextState } = decideOnce(
      makeRound({ signal_type: 'effective' }),
      makeState({ round: 2, traces: history }),
    );
    expect(nextState.traces).toHaveLength(3);
    expect(nextState.traces.slice(0, 2)).toEqual(historySnapshot);
    expect(history).toEqual(historySnapshot);
  });

  it('多轮后 traces.length === 轮数（SPEC §6.4）', () => {
    // SPEC §6.4
    const run = runPlan(repeatPattern(ROLLBACK_SIGNALS, 8));
    expect(run.final.traces).toHaveLength(8);
    expect(run.final.round).toBe(8);
    expect(run.final.traces.length).toBe(run.final.round);
    run.traces.forEach((trace, index) => {
      expect(trace.round).toBe(index + 1);
      expect(trace.note.trim().length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// G. SPEC §4 纯函数（不可变性 / 确定性）
// ─────────────────────────────────────────────────────────────

describe('SPEC §4 纯函数', () => {
  it('不修改传入的 state 与 round（深快照 + 深冻结双重验证）', () => {
    // SPEC §4「纯函数：不修改传入的 state（用深快照可验证）」+ §2「纯函数：同步、确定性、无 I/O」
    const state = makeState({
      round: 3,
      rollback_count: 1,
      consecutive: { cyclic: 1 },
    });
    const round = makeRound({ signal_type: 'type_misjudged', causal_type: 'cyclic' });
    const stateSnapshot = structuredClone(state);
    const roundSnapshot = structuredClone(round);

    deepFreeze(state);
    deepFreeze(round);

    const { decision, nextState } = decideOnce(round, state);

    expect(state).toEqual(stateSnapshot);
    expect(round).toEqual(roundSnapshot);
    expect(decision.action).toBe('rollback_to_classifier');
    expect(nextState.rollback_count).toBe(2);
  });

  it('返回的 nextState 及其嵌套容器都是新对象，不复用入参引用', () => {
    // SPEC §2「纯函数」/ §4（状态由调用方持有，逐轮传入）
    const state = makeState({ round: 1, traces: [makeTrace(1)] });
    const { nextState } = decideOnce(makeRound({ signal_type: 'effective' }), state);

    expect(nextState).not.toBe(state);
    expect(nextState.traces).not.toBe(state.traces);
    expect(nextState.oscillation).not.toBe(state.oscillation);
    expect(nextState.oscillation.consecutive_rollbacks).not.toBe(
      state.oscillation.consecutive_rollbacks,
    );
  });

  it('确定性：同输入两次调用结果深相等', () => {
    // SPEC §2「纯函数：同步、确定性、无 I/O」
    const buildRound = (): OrchestratorRound =>
      makeRound({
        signal: makeSignal('type_misjudged', { suggested_rollback: RECHECK_ROLLBACK }),
        causal_type: 'cyclic',
      });
    const buildState = (): OrchestratorState =>
      makeState({ round: 4, rollback_count: 1, consecutive: { cyclic: 1 } });

    const first = decideOnce(buildRound(), buildState());
    const second = decideOnce(buildRound(), buildState());

    expect(second).toEqual(first);
  });
});

// ─────────────────────────────────────────────────────────────
// H. SPEC §5 输入校验
// ─────────────────────────────────────────────────────────────

describe('SPEC §5 输入校验', () => {
  const validRound = (): OrchestratorRound => makeRound({ signal_type: 'effective' });
  const validState = (): OrchestratorState => makeState();

  it('round 非对象 ⇒ INVALID_RESULT', () => {
    // SPEC §5 表：`round` 非对象
    const cases: readonly unknown[] = [null, undefined, 'not-an-object', 42, true];
    for (const malformed of cases) {
      expectThrownCode(() => decideAny(malformed, validState()), 'INVALID_RESULT');
    }
  });

  it('execution / signal / path 非对象 ⇒ INVALID_RESULT（三者各一例）', () => {
    // SPEC §5 表：`execution` 或 `signal` 非对象 / `path` 非对象
    expectThrownCode(
      () => decideAny({ ...validRound(), execution: null }, validState()),
      'INVALID_RESULT',
    );
    expectThrownCode(
      () => decideAny({ ...validRound(), signal: null }, validState()),
      'INVALID_RESULT',
    );
    expectThrownCode(
      () => decideAny({ ...validRound(), path: null }, validState()),
      'INVALID_RESULT',
    );
    expectThrownCode(() => decideAny({}, validState()), 'INVALID_RESULT');
  });

  it('state 非对象 ⇒ INVALID_STATE', () => {
    // SPEC §5 表：`state` 非对象
    const cases: readonly unknown[] = [null, undefined, 'not-an-object', 7];
    for (const malformed of cases) {
      expectThrownCode(() => decideAny(validRound(), malformed), 'INVALID_STATE');
    }
  });

  it('rollback_count 非非负整数 ⇒ INVALID_STATE', () => {
    // SPEC §5 表：`rollback_count` 非非负整数
    const malformedValues: readonly unknown[] = [-1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY];
    for (const malformed of malformedValues) {
      expectThrownCode(
        () =>
          decideAny(
            validRound(),
            { ...validState(), rollback_count: malformed as number },
          ),
        'INVALID_STATE',
      );
    }
  });

  it('traces 非数组 ⇒ INVALID_STATE', () => {
    // SPEC §5 表：`traces` 非数组
    expectThrownCode(
      () => decideAny(validRound(), { ...validState(), traces: {} as unknown as readonly RoundTrace[] }),
      'INVALID_STATE',
    );
  });

  it('options.rollback_limit 非正整数 ⇒ INVALID_OPTIONS', () => {
    // SPEC §5 表：`options.rollback_limit` 非正整数（0 不是正整数）
    const malformedValues: readonly unknown[] = [0, -1, 1.5, '3', Number.NaN];
    for (const malformed of malformedValues) {
      expectThrownCode(
        () =>
          decideAny(validRound(), validState(), {
            rollback_limit: malformed as number,
          }),
        'INVALID_OPTIONS',
      );
    }
  });

  it('options.lock_rounds 非非负整数 ⇒ INVALID_OPTIONS', () => {
    // SPEC §5 表：`options.lock_rounds` 非非负整数（0 合法，故不在本用例内）
    const malformedValues: readonly unknown[] = [-1, 0.5, '1', Number.NaN];
    for (const malformed of malformedValues) {
      expectThrownCode(
        () =>
          decideAny(validRound(), validState(), {
            lock_rounds: malformed as number,
          }),
        'INVALID_OPTIONS',
      );
    }
  });

  it('合法 options（省略 / 空对象 / lock_rounds=0）不抛错（§5 反向取证）', () => {
    // SPEC §5（0 是非负整数，必须被接受）+ §2（options 可省略）
    expect(() => decideAny(validRound(), validState())).not.toThrow();
    expect(() => decideAny(validRound(), validState(), {})).not.toThrow();
    expect(() =>
      decideAny(validRound(), validState(), { rollback_limit: 1, lock_rounds: 0 }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// I. SPEC §2.1 run 闭环（端到端装配四个插件）
// ─────────────────────────────────────────────────────────────

async function makeContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(classifierPlugin);
  await ctx.plugin(strategyPlugin);
  await ctx.plugin(feedbackPlugin);
  await ctx.plugin(orchestratorPlugin);
  return ctx;
}

describe('SPEC §2.1 run 闭环', () => {
  it('run 返回时 traces 恒完整（traces.length === round），每轮 note 非空，outcome 取值合法', async () => {
    // SPEC §2.1「返回的 state.traces 恒完整（每轮一条，永不丢弃）」+ outcome 三值
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(PROBLEM, {});
      expect(RUN_OUTCOMES).toContain(result.outcome);
      expect(result.state.traces.length).toBe(result.state.round);
      expect(result.state.traces.length).toBeGreaterThanOrEqual(1);
      result.state.traces.forEach((trace, index) => {
        expect(trace.round).toBe(index + 1);
        expect(trace.note.trim().length).toBeGreaterThan(0);
      });
      expect(result.reason.trim().length).toBeGreaterThan(0);
      // SPEC §2.1 注：lock_and_continue 也算 effective 终局，调用方读 decision.action 区分
      if (result.outcome === 'effective') {
        expect(['continue', 'lock_and_continue']).toContain(result.decision.action);
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('max_rounds 是防失控保护：触顶即返回，且 trace 依然完整（SPEC §2.1）', async () => {
    // SPEC §2.1「max_rounds（缺省 32）是防失控保护」
    const ctx = await makeContext();
    try {
      const failingExecutor: ActionExecutor = {
        execute: async (invocation) => ({
          status: 'failed',
          detail: `验收构造：${invocation.action} 未成功`,
        }),
      };
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(PROBLEM, {
        max_rounds: 2,
        executor: failingExecutor,
      });
      expect(result.state.round).toBeLessThanOrEqual(2);
      expect(result.state.traces.length).toBe(result.state.round);
      expect(result.state.traces.every((trace) => trace.note.trim().length > 0)).toBe(true);
      expect(RUN_OUTCOMES).toContain(result.outcome);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// J. SPEC §6.6 职责边界（机械扫描；本套件不人工阅读实现 —— 只输出文件名与 token）
// ─────────────────────────────────────────────────────────────

describe('SPEC §6.6 职责边界静态检查', () => {
  const SRC_DIR = join(process.cwd(), 'packages', 'clis-orchestrator', 'src');

  /** import 语句级的依赖检查（不匹配注释里提到的插件名）。 */
  const FORBIDDEN_IMPORT =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@clis\/clis-(?:classifier|strategy|feedback)/;

  const FOUR_QUESTION_TOKENS: readonly string[] = [
    'FOUR_QUESTIONS',
    'q1_simultaneous_mutual_definition',
    'q2_delayed_mutual_influence',
    'q3_strict_irreversible_order',
    'q4_coexisting_causal_structures',
    'ANSWER_KEYS',
  ];

  function sourceFiles(): readonly { path: string; text: string }[] {
    const entries = readdirSync(SRC_DIR, { recursive: true }) as unknown as readonly string[];
    return entries
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => ({ path: join(SRC_DIR, entry), text: readFileSync(join(SRC_DIR, entry), 'utf8') }));
  }

  it('src/** 不 import 其它 CLIS 插件的实现（只允许 @clis/clis-contracts）', () => {
    // SPEC §1 硬约束 + §6.6
    const offenders = sourceFiles()
      .filter((file) => FORBIDDEN_IMPORT.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('src/** 不含四问符号', () => {
    // SPEC §1 硬约束 + §6.6
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const token of FOUR_QUESTION_TOKENS) {
        if (file.text.includes(token)) offenders.push(`${file.path} 含 ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});