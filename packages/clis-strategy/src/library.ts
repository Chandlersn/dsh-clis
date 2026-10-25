import type { PathScoreComponents, PathVariantId, StrategyFamily } from '@clis/clis-contracts';

/**
 * 策略库：参数化、可版本化的策略本体。
 *
 * 这里**不写自然语言忠告** —— 每个变体由四个可比较的分量 + 一串参数化动作构成：
 * 分量决定它排第几，动作决定它做什么。
 */

/** 策略库版本。任何变体内容变动都必须同时提升它。 */
export const STRATEGY_LIBRARY_VERSION = '1.0.0';

const VARIANT_VERSION = '1.0.0';

/** 库里的一步：动作名 + 参数对象 + 一句话说明。 */
export interface LibraryStepSpec {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rationale: string;
}

/** 库里的一个变体。 */
export interface LibraryVariant {
  readonly variant: PathVariantId;
  readonly variant_version: string;
  readonly family: StrategyFamily;
  readonly components: PathScoreComponents;
  readonly summary: string;
  readonly steps: readonly LibraryStepSpec[];
}

/**
 * 策略库本体，顺序即 `PATH_VARIANTS` 的声明顺序（排序同分时按此顺序稳定）。
 * 变体标识不能凭空扩写：`libraryVariant()` 只认这里的条目。
 */
export const STRATEGY_LIBRARY: readonly LibraryVariant[] = [
  // ---- structural_duality：对称映射 / 关系参数调优 / 定义澄清 ----
  {
    variant: 'duality.symmetric_mapping',
    variant_version: VARIANT_VERSION,
    family: 'duality_pairing',
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.2, execution_cost: 0.4 },
    summary: '同时对标定两极并施加对称调整，不做先后安排',
    steps: [
      {
        action: 'identify_poles',
        params: { pair: 'opposing' },
        rationale: '找出同时成立、彼此定义的两极',
      },
      {
        action: 'apply_symmetric_adjustment',
        params: { magnitude: 1, target: 'both_poles' },
        rationale: '对两极施加等量调整以保持定义关系',
      },
    ],
  },
  {
    variant: 'duality.relation_tuning',
    variant_version: VARIANT_VERSION,
    family: 'duality_pairing',
    components: { type_fit: 1, expected_effect: 0.75, side_effect_risk: 0.15, execution_cost: 0.3 },
    summary: '测量两极之间的关系参数并调参，不改变结构',
    steps: [
      {
        action: 'measure_relation_parameters',
        params: { dimensions: ['ratio', 'offset'] },
        rationale: '测量定义两极关系的参数',
      },
      {
        action: 'tune_relation_parameter',
        params: { parameter: 'ratio', delta: 0.1 },
        rationale: '微调关系参数',
      },
    ],
  },
  {
    variant: 'duality.definition_clarification',
    variant_version: VARIANT_VERSION,
    family: 'duality_pairing',
    components: { type_fit: 1, expected_effect: 0.6, side_effect_risk: 0.05, execution_cost: 0.2 },
    summary: '抽取双方定义并消解定义冲突，先求语义一致',
    steps: [
      { action: 'extract_definitions', params: { sources: ['stated'] }, rationale: '抽取两极各自的定义' },
      {
        action: 'resolve_definition_conflict',
        params: { strategy: 'prefer_explicit' },
        rationale: '按显式定义消解冲突',
      },
    ],
  },

  // ---- cyclic：杠杆点 / 增益控制 / 延迟调节 / 阻尼注入 ----
  {
    variant: 'loop.leverage_point',
    variant_version: VARIANT_VERSION,
    family: 'loop_damping',
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.25, execution_cost: 0.45 },
    summary: '定位反馈环并按增益/延迟比排序杠杆点，只在杠杆点干预',
    steps: [
      { action: 'map_feedback_loop', params: { nodes: ['a', 'b'] }, rationale: '定位闭环上的节点' },
      {
        action: 'rank_leverage_points',
        params: { metric: 'gain_over_delay' },
        rationale: '按增益与延迟之比给节点排序',
      },
      {
        action: 'intervene_at_leverage_point',
        params: { target: 'top1', strength: 1 },
        rationale: '只在杠杆点施加干预',
      },
    ],
  },
  {
    variant: 'loop.gain_control',
    variant_version: VARIANT_VERSION,
    family: 'loop_damping',
    components: { type_fit: 1, expected_effect: 0.8, side_effect_risk: 0.2, execution_cost: 0.3 },
    summary: '测量环增益并限幅，抑制振荡幅度',
    steps: [
      { action: 'measure_loop_gain', params: { method: 'step_response' }, rationale: '测量环增益' },
      { action: 'limit_gain', params: { max_gain: 1 }, rationale: '限制环增益上限' },
    ],
  },
  {
    variant: 'loop.delay_tuning',
    variant_version: VARIANT_VERSION,
    family: 'loop_damping',
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.15, execution_cost: 0.3 },
    summary: '测量并改变环上的时间延迟，借相移削弱振荡',
    steps: [
      { action: 'measure_loop_delay', params: { unit: 'ms' }, rationale: '测量环上的时间延迟' },
      {
        action: 'shift_delay',
        params: { delta: 10, direction: 'shorten' },
        rationale: '缩短或延长延迟以改变相位',
      },
    ],
  },
  {
    variant: 'loop.damping_injection',
    variant_version: VARIANT_VERSION,
    family: 'loop_damping',
    components: { type_fit: 1, expected_effect: 0.65, side_effect_risk: 0.1, execution_cost: 0.35 },
    summary: '在环上注入阻尼项，直接消耗振荡能量',
    steps: [
      { action: 'inject_damping', params: { coefficient: 0.2, at: 'loop' }, rationale: '注入阻尼系数' },
    ],
  },

  // ---- unidirectional：必要条件 / 上游追溯 / 不可逆性接受 / 新因果覆盖 ----
  {
    variant: 'lever.necessary_condition',
    variant_version: VARIANT_VERSION,
    family: 'single_lever',
    components: { type_fit: 1, expected_effect: 0.75, side_effect_risk: 0.2, execution_cost: 0.3 },
    summary: '枚举候选条件、逐一移除验证必要性，再施加必要条件',
    steps: [
      {
        action: 'enumerate_conditions',
        params: { candidates: ['cause'] },
        rationale: '枚举可能的原因条件',
      },
      { action: 'test_necessity', params: { method: 'remove_one' }, rationale: '逐个移除以检验必要性' },
      { action: 'enforce_condition', params: { condition: 'cause' }, rationale: '施加已验证的必要条件' },
    ],
  },
  {
    variant: 'lever.upstream_trace',
    variant_version: VARIANT_VERSION,
    family: 'single_lever',
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.3, execution_cost: 0.4 },
    summary: '向上游追溯到最早可干预的因，在那里动手',
    steps: [
      { action: 'trace_upstream', params: { max_depth: 3 }, rationale: '向上游追溯因果链' },
      {
        action: 'select_upstream_intervention',
        params: { chosen: 'earliest' },
        rationale: '选定最早可干预的节点',
      },
      { action: 'apply_intervention', params: { strength: 1 }, rationale: '在该节点施加干预' },
    ],
  },
  {
    variant: 'lever.irreversibility_acceptance',
    variant_version: VARIANT_VERSION,
    family: 'single_lever',
    components: { type_fit: 1, expected_effect: 0.5, side_effect_risk: 0.05, execution_cost: 0.1 },
    summary: '确认不可逆性并接受之，只做绕行规划',
    steps: [
      {
        action: 'confirm_irreversibility',
        params: { evidence: ['no_restore_path'] },
        rationale: '确认该因果不可逆',
      },
      {
        action: 'accept_and_plan_around',
        params: { constraint: 'irreversible' },
        rationale: '接受不可逆并规划绕行',
      },
    ],
  },
  {
    variant: 'lever.new_causal_overlay',
    variant_version: VARIANT_VERSION,
    family: 'single_lever',
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.35, execution_cost: 0.5 },
    summary: '设计一条新的因去覆盖原结果，绕开不可逆的旧因',
    steps: [
      {
        action: 'design_overlay_cause',
        params: { target_effect: 'outcome' },
        rationale: '设计能覆盖目标结果的新因',
      },
      { action: 'apply_overlay', params: { strength: 1 }, rationale: '施加新的因' },
    ],
  },

  // ---- nested：组合子模块策略 ----
  {
    variant: 'decompose.compose_sub',
    variant_version: VARIANT_VERSION,
    family: 'decompose',
    components: { type_fit: 1, expected_effect: 0.8, side_effect_risk: 0.25, execution_cost: 0.55 },
    summary: '按子模块切分，并对每个子模块组合各自家族的策略',
    steps: [
      {
        action: 'partition_sub_modules',
        params: { count: 0 },
        rationale: '按子模块切分并逐个处理',
      },
    ],
  },

  // ---- probe_and_observe：探索模式 ----
  {
    variant: 'probe.minimal',
    variant_version: VARIANT_VERSION,
    family: 'probe_and_observe',
    components: { type_fit: 1, expected_effect: 0.5, side_effect_risk: 0.1, execution_cost: 0.15 },
    summary: '最小成本探测一次并观察响应，先拿到一点信息',
    steps: [
      {
        action: 'probe_environment',
        params: { targets: ['unknown'], sample_size: 1 },
        rationale: '最小规模探测环境',
      },
      {
        action: 'observe_response',
        params: { window: 1, metrics: ['signal'] },
        rationale: '观察最小窗口的响应',
      },
    ],
  },
  {
    variant: 'probe.broad',
    variant_version: VARIANT_VERSION,
    family: 'probe_and_observe',
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.3, execution_cost: 0.45 },
    summary: '多目标、多指标的广度探测，换取更全面的观察',
    steps: [
      {
        action: 'probe_environment',
        params: { targets: ['unknown'], sample_size: 5 },
        rationale: '多目标探测环境',
      },
      {
        action: 'observe_response',
        params: { window: 5, metrics: ['signal', 'trend', 'noise'] },
        rationale: '观察多指标响应',
      },
    ],
  },
];

/** 按变体标识取库条目；库外标识返回 undefined（不凭空扩写变体）。 */
export function libraryVariant(variant: PathVariantId): LibraryVariant | undefined {
  return STRATEGY_LIBRARY.find((entry) => entry.variant === variant);
}