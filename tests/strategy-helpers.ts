/**
 * clis-strategy 独立黑盒验收套件的共享工具。
 *
 * 纪律：一切期望值只来自 `docs/SPEC-strategy.md`（冻结规格）与 `@clis/clis-contracts`
 * （含排序公式的唯一实现 `scorePath` / 边界唯一实现 `blockedReason`），
 * 绝不从 `packages/clis-strategy/src/**` 反推。
 * （唯一例外：`strategy-static.test.ts` 依 SPEC §7-11 读源码文本做静态断言。）
 *
 * 本文件刻意**不** import `@clis/clis-strategy`：预言机与实现无关，且模块解析失败时
 * 工具函数仍可正常工作，故障面被限制在测试文件内。
 */
import { expect } from 'vitest';

import {
  DEFAULT_MAX_DEPTH,
  EXECUTION_SIGNAL_KINDS,
  FAMILY_BY_TYPE,
  PATH_VARIANTS,
  PROBE_FAMILY,
  blockedReason,
  scorePath,
} from '@clis/clis-contracts';
import type {
  ActionExecutor,
  ActionInvocation,
  ActionResult,
  ActionResultStatus,
  BlockedAction,
  CandidatePath,
  CausalClassification,
  CausalType,
  ExecutionResult,
  ExecutionSignal,
  PathScoreComponents,
  PathStep,
  PathVariantId,
  StrategyBoundary,
  StrategyFamily,
} from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';

import { makeProblem } from './helpers';

/** SPEC §2/§3：策略库与变体版本逐字固定。 */
export const EXPECTED_LIBRARY_VERSION = '1.0.0';
export const EXPECTED_VARIANT_VERSION = '1.0.0';

export interface SpecStep {
  readonly action: string;
  /** SPEC §3.2 在 `{}` 内逐字列出的参数名。 */
  readonly paramKeys: readonly string[];
  /** SPEC §3.2 已逐字给出取值的参数。 */
  readonly fixedParams?: Readonly<Record<string, unknown>>;
}

export interface SpecVariant {
  readonly variant: PathVariantId;
  readonly family: StrategyFamily;
  /** SPEC §3.1 四个分量，逐字固定。 */
  readonly components: PathScoreComponents;
  /** SPEC §3.2 步骤（按序）。 */
  readonly steps: readonly SpecStep[];
  /** SPEC §3.2 注明"子模块另出子路径"的变体。 */
  readonly producesSubPaths: boolean;
}

/**
 * SPEC §3.1 + §3.2 的逐字转写。
 * 表内**不含**任何实现信息：分量来自 §3.1 表格，步骤与参数名来自 §3.2 表格。
 */
export const VARIANT_SPECS: Readonly<Record<PathVariantId, SpecVariant>> = {
  'duality.symmetric_mapping': {
    variant: 'duality.symmetric_mapping',
    family: 'duality_pairing',
    components: { type_fit: 1.0, expected_effect: 0.9, side_effect_risk: 0.2, execution_cost: 0.4 },
    steps: [
      { action: 'identify_poles', paramKeys: ['pair'] },
      {
        action: 'apply_symmetric_adjustment',
        paramKeys: ['magnitude', 'target'],
        fixedParams: { target: 'both_poles' },
      },
    ],
    producesSubPaths: false,
  },
  'duality.relation_tuning': {
    variant: 'duality.relation_tuning',
    family: 'duality_pairing',
    components: { type_fit: 1.0, expected_effect: 0.75, side_effect_risk: 0.15, execution_cost: 0.3 },
    steps: [
      { action: 'measure_relation_parameters', paramKeys: ['dimensions'] },
      { action: 'tune_relation_parameter', paramKeys: ['parameter', 'delta'] },
    ],
    producesSubPaths: false,
  },
  'duality.definition_clarification': {
    variant: 'duality.definition_clarification',
    family: 'duality_pairing',
    components: { type_fit: 1.0, expected_effect: 0.6, side_effect_risk: 0.05, execution_cost: 0.2 },
    steps: [
      { action: 'extract_definitions', paramKeys: ['sources'] },
      {
        action: 'resolve_definition_conflict',
        paramKeys: ['strategy'],
        fixedParams: { strategy: 'prefer_explicit' },
      },
    ],
    producesSubPaths: false,
  },
  'loop.leverage_point': {
    variant: 'loop.leverage_point',
    family: 'loop_damping',
    components: { type_fit: 1.0, expected_effect: 0.9, side_effect_risk: 0.25, execution_cost: 0.45 },
    steps: [
      { action: 'map_feedback_loop', paramKeys: ['nodes'] },
      {
        action: 'rank_leverage_points',
        paramKeys: ['metric'],
        fixedParams: { metric: 'gain_over_delay' },
      },
      { action: 'intervene_at_leverage_point', paramKeys: ['target', 'strength'] },
    ],
    producesSubPaths: false,
  },
  'loop.gain_control': {
    variant: 'loop.gain_control',
    family: 'loop_damping',
    components: { type_fit: 1.0, expected_effect: 0.8, side_effect_risk: 0.2, execution_cost: 0.3 },
    steps: [
      { action: 'measure_loop_gain', paramKeys: ['method'] },
      { action: 'limit_gain', paramKeys: ['max_gain'] },
    ],
    producesSubPaths: false,
  },
  'loop.delay_tuning': {
    variant: 'loop.delay_tuning',
    family: 'loop_damping',
    components: { type_fit: 1.0, expected_effect: 0.7, side_effect_risk: 0.15, execution_cost: 0.3 },
    steps: [
      { action: 'measure_loop_delay', paramKeys: ['unit'] },
      { action: 'shift_delay', paramKeys: ['delta', 'direction'] },
    ],
    producesSubPaths: false,
  },
  'loop.damping_injection': {
    variant: 'loop.damping_injection',
    family: 'loop_damping',
    components: { type_fit: 1.0, expected_effect: 0.65, side_effect_risk: 0.1, execution_cost: 0.35 },
    steps: [{ action: 'inject_damping', paramKeys: ['coefficient', 'at'] }],
    producesSubPaths: false,
  },
  'lever.necessary_condition': {
    variant: 'lever.necessary_condition',
    family: 'single_lever',
    components: { type_fit: 1.0, expected_effect: 0.8, side_effect_risk: 0.2, execution_cost: 0.3 },
    steps: [
      { action: 'enumerate_conditions', paramKeys: ['candidates'] },
      { action: 'test_necessity', paramKeys: ['method'], fixedParams: { method: 'remove_one' } },
      { action: 'enforce_condition', paramKeys: ['condition'] },
    ],
    producesSubPaths: false,
  },
  'lever.upstream_trace': {
    variant: 'lever.upstream_trace',
    family: 'single_lever',
    components: { type_fit: 1.0, expected_effect: 0.85, side_effect_risk: 0.3, execution_cost: 0.4 },
    steps: [
      { action: 'trace_upstream', paramKeys: ['max_depth'] },
      { action: 'select_upstream_intervention', paramKeys: ['chosen'] },
      { action: 'apply_intervention', paramKeys: ['strength'] },
    ],
    producesSubPaths: false,
  },
  'lever.irreversibility_acceptance': {
    variant: 'lever.irreversibility_acceptance',
    family: 'single_lever',
    components: { type_fit: 1.0, expected_effect: 0.5, side_effect_risk: 0.05, execution_cost: 0.1 },
    steps: [
      { action: 'confirm_irreversibility', paramKeys: ['evidence'] },
      { action: 'accept_and_plan_around', paramKeys: ['constraint'] },
    ],
    producesSubPaths: false,
  },
  'lever.new_causal_overlay': {
    variant: 'lever.new_causal_overlay',
    family: 'single_lever',
    components: { type_fit: 1.0, expected_effect: 0.7, side_effect_risk: 0.35, execution_cost: 0.5 },
    steps: [
      { action: 'design_overlay_cause', paramKeys: ['target_effect'] },
      { action: 'apply_overlay', paramKeys: ['strength'] },
    ],
    producesSubPaths: false,
  },
  'decompose.compose_sub': {
    variant: 'decompose.compose_sub',
    family: 'decompose',
    components: { type_fit: 1.0, expected_effect: 0.8, side_effect_risk: 0.25, execution_cost: 0.55 },
    steps: [{ action: 'partition_sub_modules', paramKeys: ['count'] }],
    producesSubPaths: true,
  },
  'probe.minimal': {
    variant: 'probe.minimal',
    family: 'probe_and_observe',
    components: { type_fit: 1.0, expected_effect: 0.5, side_effect_risk: 0.1, execution_cost: 0.15 },
    steps: [
      {
        action: 'probe_environment',
        paramKeys: ['targets', 'sample_size'],
        fixedParams: { sample_size: 1 },
      },
      {
        action: 'observe_response',
        paramKeys: ['window', 'metrics'],
        fixedParams: { window: 1, metrics: ['signal'] },
      },
    ],
    producesSubPaths: false,
  },
  'probe.broad': {
    variant: 'probe.broad',
    family: 'probe_and_observe',
    components: { type_fit: 1.0, expected_effect: 0.7, side_effect_risk: 0.3, execution_cost: 0.45 },
    steps: [
      {
        action: 'probe_environment',
        paramKeys: ['targets', 'sample_size'],
        fixedParams: { sample_size: 5 },
      },
      {
        action: 'observe_response',
        paramKeys: ['window', 'metrics'],
        fixedParams: { window: 5, metrics: ['signal', 'trend', 'noise'] },
      },
    ],
    producesSubPaths: false,
  },
};

/** SPEC §3.2 动作集合的并集：返回路径的每个动作都必须取自它（§1）。 */
export const ALL_SPEC_ACTIONS: readonly string[] = [
  ...new Set(Object.values(VARIANT_SPECS).flatMap((spec) => spec.steps.map((step) => step.action))),
];

/** SPEC §3.2 动作集合（27 个）。 */
export const SPEC_ACTION_COUNT = 27;

export const NO_BOUNDARY: StrategyBoundary = { forbidden_actions: [] };

export function boundary(
  forbidden: readonly string[] = [],
  allowed?: readonly string[],
): StrategyBoundary {
  return allowed === undefined
    ? { forbidden_actions: [...forbidden] }
    : { forbidden_actions: [...forbidden], allowed_actions: [...allowed] };
}

// —— 由 SPEC §4 推导的候选集与名次预言机 ——

export function familyForClassification(classification: CausalClassification): StrategyFamily {
  if (classification.causal_type === 'unknown') return PROBE_FAMILY;
  return FAMILY_BY_TYPE[classification.causal_type];
}

/**
 * SPEC §4.2：家族全部变体 +（条件满足且集合内没有时）追加 `probe.minimal`。
 * 追加条件：(a) needs_exploration === true 且 causal_type !== 'unknown'；
 * 或 (b) causal_type === 'nested' 且 sub_modules 为空。
 */
export function shouldAppendProbeCandidate(classification: CausalClassification): boolean {
  const exploringKnownType =
    classification.needs_exploration === true && classification.causal_type !== 'unknown';
  const nestedWithoutSubModules =
    classification.causal_type === 'nested' &&
    (classification.sub_modules ?? []).length === 0;
  return exploringKnownType || nestedWithoutSubModules;
}

/** 候选变体（**声明顺序**，即 path_id 编号顺序）。 */
export function expectedCandidateVariants(
  classification: CausalClassification,
): readonly PathVariantId[] {
  const family = familyForClassification(classification);
  const base = PATH_VARIANTS.filter((variant) => VARIANT_SPECS[variant].family === family);
  const appended: PathVariantId[] =
    shouldAppendProbeCandidate(classification) && !base.includes('probe.minimal')
      ? ['probe.minimal']
      : [];
  return [...base, ...appended];
}

/** 追加到已知类型候选集里的探索候选 `type_fit` 取 0.5（SPEC §3.1 末尾）。 */
export function expectedComponents(
  variant: PathVariantId,
  classification: CausalClassification,
): PathScoreComponents {
  const isAppended =
    variant === 'probe.minimal' && familyForClassification(classification) !== PROBE_FAMILY;
  const base = VARIANT_SPECS[variant].components;
  return isAppended ? { ...base, type_fit: 0.5 } : { ...base };
}

export interface ExpectedCandidate {
  readonly variant: PathVariantId;
  readonly family: StrategyFamily;
  readonly components: PathScoreComponents;
  readonly score: number;
  readonly rank: number;
  readonly path_id: string;
  readonly appended: boolean;
}

/**
 * 由 SPEC §4.3/§4.4/§4.5 推导的名次表：
 * score = `scorePath(components)`（契约唯一实现，不在此重写公式）；
 * score 降序、同分保持 PATH_VARIANTS 声明顺序；
 * path_id 按声明顺序编号 p1..pn（与分数无关）。
 */
export function expectedRankedCandidates(
  classification: CausalClassification,
): readonly ExpectedCandidate[] {
  const variants = expectedCandidateVariants(classification);
  const entries = variants.map((variant, declarationIndex) => {
    const components = expectedComponents(variant, classification);
    return {
      variant,
      family: VARIANT_SPECS[variant].family,
      components,
      score: scorePath(components),
      declarationIndex,
      appended: variant === 'probe.minimal' && familyForClassification(classification) !== PROBE_FAMILY,
      path_id: `p${declarationIndex + 1}`,
    };
  });
  // Array.prototype.sort 自 ES2019 起稳定 ⇒ 同分项保持声明顺序（§4.4）。
  const ranked = [...entries].sort((left, right) => right.score - left.score);
  return ranked.map((entry, index) => ({
    variant: entry.variant,
    family: entry.family,
    components: entry.components,
    score: entry.score,
    rank: index + 1,
    path_id: entry.path_id,
    appended: entry.appended,
  }));
}

/** 某类型下家族自有变体的最高分者。 */
export function expectedTopForClassification(classification: CausalClassification): ExpectedCandidate {
  const ranked = expectedRankedCandidates(classification);
  return ranked[0] as ExpectedCandidate;
}

/**
 * SPEC §4.6（2026-10-25 补注）：子路径取该子模块候选集中**名次最好的可执行候选**；
 * 若全部候选都不可执行，退化为 rank 1（执行时判 blocked）。
 */
export function expectedSubPathCandidate(
  childClassification: CausalClassification,
  strategyBoundary: StrategyBoundary,
): ExpectedCandidate {
  const ranked = expectedRankedCandidates(childClassification);
  const executable = ranked.filter(
    (candidate) => expectedBlockedActions(candidate.variant, strategyBoundary).length === 0,
  );
  return executable.length > 0 ? (executable[0] as ExpectedCandidate) : (ranked[0] as ExpectedCandidate);
}

// —— 边界预言机（用契约的 blockedReason，不重写判定） ——

export function expectedBlockedActions(
  variant: PathVariantId,
  strategyBoundary: StrategyBoundary,
): readonly BlockedAction[] {
  const seen = new Set<string>();
  const blocked: BlockedAction[] = [];
  for (const step of VARIANT_SPECS[variant].steps) {
    const reason = blockedReason(step.action, strategyBoundary);
    if (reason !== null && !seen.has(step.action)) {
      seen.add(step.action);
      blocked.push({ action: step.action, reason });
    }
  }
  return blocked;
}

export function expectedRemainingStepActions(
  variant: PathVariantId,
  strategyBoundary: StrategyBoundary,
): readonly string[] {
  return VARIANT_SPECS[variant].steps
    .filter((step) => blockedReason(step.action, strategyBoundary) === null)
    .map((step) => step.action);
}

// —— 断言助手 ——

/** SPEC §3.2：步骤动作、参数名、固定取值、index、rationale。 */
export function expectStepsMatchSpec(path: CandidatePath): void {
  const spec = VARIANT_SPECS[path.variant];
  expect(path.steps.length).toBe(spec.steps.length);
  path.steps.forEach((step, index) => {
    const expected = spec.steps[index] as SpecStep;
    expect(step.index).toBe(index);
    expect(step.action).toBe(expected.action);
    expect(typeof step.params).toBe('object');
    expect(step.params).not.toBeNull();
    expect(Array.isArray(step.params)).toBe(false);
    for (const key of expected.paramKeys) {
      expect(Object.prototype.hasOwnProperty.call(step.params, key)).toBe(true);
    }
    for (const [key, value] of Object.entries(expected.fixedParams ?? {})) {
      expect(step.params[key]).toStrictEqual(value);
    }
    expect(typeof step.rationale).toBe('string');
    expect(step.rationale.length).toBeGreaterThan(0);
    expect(step.rationale.length).toBeLessThanOrEqual(60);
  });
}

/** 单条路径对预言机的核对（不涉及 boundary）。 */
export function expectPathMatchesOracle(path: CandidatePath, expected: ExpectedCandidate): void {
  expect(path.variant).toBe(expected.variant);
  expect(path.family).toBe(expected.family);
  expect(path.variant_version).toBe(EXPECTED_VARIANT_VERSION);
  expect(path.library_version).toBe(EXPECTED_LIBRARY_VERSION);
  expect(path.path_id).toBe(expected.path_id);
  expect(path.rank).toBe(expected.rank);
  expect(path.components).toStrictEqual(expected.components);
  // §7-1 核心：排序分必须能用契约包函数复算
  expect(path.score).toBe(scorePath(path.components));
  expect(path.score).toBe(expected.score);
  expect(typeof path.summary).toBe('string');
  expect(path.summary.length).toBeGreaterThan(0);
  expect(path.summary.length).toBeLessThanOrEqual(80);
  expectStepsMatchSpec(path);
}

export function expectMatchesOracle(
  paths: readonly CandidatePath[],
  classification: CausalClassification,
): void {
  const expected = expectedRankedCandidates(classification);
  expect(paths.length).toBe(expected.length);
  paths.forEach((path, index) => {
    expectPathMatchesOracle(path, expected[index] as ExpectedCandidate);
    expect(path.causal_type).toBe(classification.causal_type);
  });
}

/** 通用结构不变量违规清单（返回字符串便于汇总）。 */
export function pathViolations(
  paths: readonly CandidatePath[],
  strategyBoundary: StrategyBoundary,
  label: string,
): string[] {
  const bad: string[] = [];
  if (paths.length === 0) bad.push(`${label}: 候选路径必须至少 1 条`);

  paths.forEach((path, index) => {
    const where = `${label}[${index}:${path.path_id}]`;
    const spec = VARIANT_SPECS[path.variant];
    if (spec === undefined) {
      bad.push(`${where}: 变体 ${String(path.variant)} 不在 SPEC §3.1 表内`);
      return;
    }
    if (path.family !== spec.family) {
      bad.push(`${where}: family 应为 ${spec.family}，实际 ${path.family}`);
    }
    if (path.score !== scorePath(path.components)) {
      bad.push(`${where}: score(${path.score}) ≠ scorePath(components)(${scorePath(path.components)})`);
    }
    if (!(path.score >= 0 && path.score <= 1)) {
      bad.push(`${where}: score 必须在 [0,1]，实际 ${path.score}`);
    }
    if (path.executable !== (path.blocked_actions.length === 0)) {
      bad.push(`${where}: executable 必须等价于 blocked_actions.length === 0`);
    }
    if (path.variant_version !== EXPECTED_VARIANT_VERSION) {
      bad.push(`${where}: variant_version 应为 ${EXPECTED_VARIANT_VERSION}`);
    }
    if (path.library_version !== EXPECTED_LIBRARY_VERSION) {
      bad.push(`${where}: library_version 应为 ${EXPECTED_LIBRARY_VERSION}`);
    }
    if (typeof path.summary !== 'string' || path.summary.length === 0 || path.summary.length > 80) {
      bad.push(`${where}: summary 必须非空且 ≤80 字`);
    }
    path.steps.forEach((step, stepIndex) => {
      if (step.index !== stepIndex) bad.push(`${where}: step.index 必须从 0 起连续`);
      if (typeof step.params !== 'object' || step.params === null || Array.isArray(step.params)) {
        bad.push(`${where}[${stepIndex}]: params 必须是对象（可为空对象）`);
      }
      if (
        typeof step.rationale !== 'string' ||
        step.rationale.length === 0 ||
        step.rationale.length > 60
      ) {
        bad.push(`${where}[${stepIndex}]: rationale 必须非空且 ≤60 字`);
      }
      if (!ALL_SPEC_ACTIONS.includes(step.action)) {
        bad.push(`${where}[${stepIndex}]: 动作 ${step.action} 不在 SPEC §3.2 动作集合内`);
      }
      if (blockedReason(step.action, strategyBoundary) !== null) {
        bad.push(`${where}[${stepIndex}]: steps 含被边界阻断的动作 ${step.action}`);
      }
    });
    for (const blocked of path.blocked_actions) {
      const reason = blockedReason(blocked.action, strategyBoundary);
      if (reason === null) bad.push(`${where}: blocked_actions 含未被阻断的动作 ${blocked.action}`);
      else if (blocked.reason !== reason) {
        bad.push(`${where}: ${blocked.action} 的原因应为 ${reason}，实际 ${blocked.reason}`);
      }
    }
    const blockedNames = path.blocked_actions.map((item) => item.action);
    if (new Set(blockedNames).size !== blockedNames.length) {
      bad.push(`${where}: blocked_actions 必须按动作名去重`);
    }
  });

  // §7-3：rank 从 1 起连续；数组顺序 = rank 升序；score 非增
  const ranks = paths.map((path) => path.rank).sort((left, right) => left - right);
  ranks.forEach((rank, index) => {
    if (rank !== index + 1) bad.push(`${label}: rank 必须从 1 起连续，实际 [${ranks.join(',')}]`);
  });
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1] as CandidatePath;
    const current = paths[index] as CandidatePath;
    if (current.rank !== previous.rank + 1) {
      bad.push(`${label}: 返回顺序必须按 rank 升序（见 path_id ${previous.path_id}→${current.path_id}）`);
    }
    if (current.score > previous.score) {
      bad.push(`${label}: score 必须非增（${previous.score} → ${current.score}）`);
    }
  }
  return bad;
}

/** 递归遍历路径树（含 sub_paths）。 */
export function flattenPaths(paths: readonly CandidatePath[]): readonly CandidatePath[] {
  const out: CandidatePath[] = [];
  const walk = (list: readonly CandidatePath[]): void => {
    for (const path of list) {
      out.push(path);
      walk(path.sub_paths ?? []);
    }
  };
  walk(paths);
  return out;
}

// —— 执行器 fake：记录调用序列 ——

export interface ExecutorFake {
  readonly executor: ActionExecutor;
  readonly calls: ActionInvocation[];
}

/** 脚本按调用序号给出状态；缺省一律 ok。 */
export function makeExecutor(script: readonly ActionResultStatus[] = []): ExecutorFake {
  const calls: ActionInvocation[] = [];
  const executor: ActionExecutor = {
    async execute(invocation: ActionInvocation): Promise<ActionResult> {
      const index = calls.length;
      calls.push(invocation);
      const status = script[index] ?? 'ok';
      return { status, detail: `receipt#${index + 1}:${invocation.action}` };
    },
  };
  return { executor, calls };
}

/** 手搓路径（路径是数据，调用方可能手搓 —— SPEC §5 执行阶段要求）。 */
export function craftStep(
  index: number,
  action: string,
  params: Readonly<Record<string, unknown>> = {},
): PathStep {
  return { index, action, params, rationale: `手搓步骤 ${index}` };
}

export function craftPath(partial: Partial<CandidatePath> & { steps: readonly PathStep[] }): CandidatePath {
  const components: PathScoreComponents =
    partial.components ?? VARIANT_SPECS['duality.symmetric_mapping'].components;
  return {
    path_id: 'p1',
    variant: 'duality.symmetric_mapping',
    variant_version: EXPECTED_VARIANT_VERSION,
    library_version: EXPECTED_LIBRARY_VERSION,
    family: 'duality_pairing',
    causal_type: 'structural_duality',
    blocked_actions: [],
    executable: true,
    rank: 1,
    summary: '手搓路径',
    ...partial,
    components,
    score: partial.score ?? scorePath(components),
  };
}

// —— 预置分类结论（输入来自已验证的 clis-classifier，不是手搓的假结构） ——

function expectClassification(
  classification: CausalClassification,
  causalType: CausalType,
  needsExploration: boolean,
): CausalClassification {
  expect(classification.causal_type).toBe(causalType);
  expect(classification.needs_exploration).toBe(needsExploration);
  return classification;
}

export function dualityClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('yes', 'no', 'no', 'no')),
    'structural_duality',
    false,
  );
}

/** structural_duality 但进入探索模式（3 个 unknown ⇒ 0.66）⇒ §4.2(a) 追加探索候选。 */
export function dualityExploringClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('yes', 'unknown', 'unknown', 'unknown')),
    'structural_duality',
    true,
  );
}

export function cyclicClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('no', 'yes', 'no', 'no')),
    'cyclic',
    false,
  );
}

export function unidirectionalClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('no', 'no', 'yes', 'no')),
    'unidirectional',
    false,
  );
}

/** nested 且 sub_modules 为空 ⇒ §4.2(b) 追加探索候选。 */
export function nestedEmptyClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'yes')),
    'nested',
    false,
  );
}

/** nested 且 2 个子模块（cyclic + unidirectional），不探索。 */
export function nestedTwoChildrenClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [makeProblem('no', 'yes', 'no', 'no'), makeProblem('no', 'no', 'yes', 'no')],
      }),
    ),
    'nested',
    false,
  );
}

/** nested + 探索模式 + 非空 sub_modules（满足 §4.2(a)，且 (b) 不成立）。 */
export function nestedExploringWithChildrenClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(
      makeProblem('unknown', 'unknown', 'unknown', 'yes', {
        sub_problems: [makeProblem('no', 'yes', 'no', 'no')],
      }),
    ),
    'nested',
    true,
  );
}

/** unknown（四问全 no）⇒ 家族已是 probe_and_observe，不得重复追加。 */
export function unknownClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'no')),
    'unknown',
    true,
  );
}

/** 三层：根 nested → 子 nested → 孙 unidirectional（用于深度与子路径 id）。 */
export function nestedDeepClassification(): CausalClassification {
  return expectClassification(
    classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'no', 'no', 'yes', {
            sub_problems: [makeProblem('no', 'no', 'yes', 'no')],
          }),
        ],
      }),
    ),
    'nested',
    false,
  );
}

export const ALL_CLASSIFICATIONS: ReadonlyArray<{ readonly name: string; readonly classification: CausalClassification }> =
  [
    { name: 'structural_duality', classification: dualityClassification() },
    { name: 'structural_duality+exploring', classification: dualityExploringClassification() },
    { name: 'cyclic', classification: cyclicClassification() },
    { name: 'unidirectional', classification: unidirectionalClassification() },
    { name: 'nested(empty sub_modules)', classification: nestedEmptyClassification() },
    { name: 'nested(2 children)', classification: nestedTwoChildrenClassification() },
    { name: 'nested(exploring+children)', classification: nestedExploringWithChildrenClassification() },
    { name: 'unknown', classification: unknownClassification() },
  ];

export const DEFAULT_MATCH_DEPTH = DEFAULT_MAX_DEPTH;

/** 信号不变量违规清单（SPEC §6.4）。 */
export function signalViolations(result: ExecutionResult, label: string): string[] {
  const bad: string[] = [];
  const signals = result.signals;
  if (!Array.isArray(signals) || signals.length === 0) {
    bad.push(`${label}: signals 恒非空`);
    return bad;
  }
  signals.forEach((signal, index) => {
    if (typeof signal.detail !== 'string' || signal.detail.length === 0) {
      bad.push(`${label}: signals[${index}].detail 必须非空`);
    }
    if (!(EXECUTION_SIGNAL_KINDS as readonly string[]).includes(signal.kind)) {
      bad.push(`${label}: signals[${index}].kind 非法：${String(signal.kind)}`);
    }
    if (signal.path_id !== result.path_id) {
      bad.push(`${label}: signals[${index}].path_id 应为 ${result.path_id}`);
    }
  });
  const last = signals[signals.length - 1] as ExecutionSignal;
  if (last.kind !== 'summary') bad.push(`${label}: 末条信号必须为 summary，实际 ${last.kind}`);
  if (last.step_index !== -1) bad.push(`${label}: 末条 summary 的 step_index 必须为 -1`);
  if (last.action !== 'summary') bad.push(`${label}: 末条 summary 的 action 必须为 'summary'`);
  return bad;
}

/** 递归收集结果树里的所有键名，用于"不得含回退字段"检查（SPEC §6.6）。 */
export function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

export const FORBIDDEN_RESULT_KEY = /rollback|next_action|suggested/i;