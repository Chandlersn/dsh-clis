import type { Context } from '@deepseek-ai/cordis';

/**
 * CLIS 的工具入口 —— 只做**转发**，不含任何判据。
 *
 * 为什么需要这一层：四个子插件注册的是 Cordis **服务**（进程内），
 * 而 agent 只能通过**工具**触达。这一层把工具调用转成服务调用，
 * 让 agent 能在对话里真正用上 CLIS。
 *
 * 职责边界不变：
 * - 分类在 clis.causalClassifier
 * - 匹配在 clis.causalStrategy
 * - 反馈在 clis.causalFeedback
 * - 编排在 clis.causalOrchestrator
 * 本文件只做参数整形与结果渲染。
 */

const SERVICE_CLASSIFIER = 'clis.causalClassifier';
const SERVICE_ORCHESTRATOR = 'clis.causalOrchestrator';
const SERVICE_STRATEGY = 'clis.causalStrategy';

/** 四问的字段名，与契约包一致。 */
const ANSWER_KEYS = [
  'q1_simultaneous_mutual_definition',
  'q2_delayed_mutual_influence',
  'q3_strict_irreversible_order',
  'q4_coexisting_causal_structures',
];

/**
 * 把工具参数里的四问整形成 CausalProblem。
 *
 * @param args — 工具入参。
 * @returns CausalProblem。
 */
function toProblem(args) {
  return {
    description: args.description,
    answers: {
      q1_simultaneous_mutual_definition: args.q1,
      q2_delayed_mutual_influence: args.q2,
      q3_strict_irreversible_order: args.q3,
      q4_coexisting_causal_structures: args.q4,
    },
  };
}

/**
 * 把工具入参中的 boundary 整形成 StrategyBoundary。
 *
 * @param args — 工具入参。
 * @returns StrategyBoundary。
 */
function toBoundary(args) {
  return {
    forbidden_actions: args.forbidden_actions ?? [],
  };
}

const ANSWERS_SCHEMA_DESCRIPTION =
  '四问作答，每项 yes/no/unknown。Q1 是否同时成立、彼此定义、无时间先后；Q2 是否存在带时间延迟的相互影响（A→B→A）；Q3 是否 A→B 严格先后且不可逆；Q4 是否同时存在多种因果结构。';

/**
 * 注册 CLIS 的工具。
 *
 * @param ctx — 已注入 tools 服务的上下文。
 */
export function registerTools(ctx: Context): void {
  // —— 工具 1：完整闭环 ——
  ctx.tools.register(
    ctx.defineTool?.({
      name: 'clis_run',
      description:
        '按因果类型处理一个问题：先判断因果类型（结构对偶/循环/单向/嵌套/未知），再匹配策略、生成候选路径并执行，依据反馈信号决定继续、换路径或回退。适用于需要先辨明因果结构再动手的问题，例如反馈回路该怎么干预、单向依赖能否逆转、两个概念是否互为定义。返回因果类型、判断依据、候选项、反馈信号与完整 trace。',
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: '问题描述，一句话说清 A 与 B 的关系。',
        },
        q1: {
          type: 'string',
          required: true,
          enum: ['yes', 'no', 'unknown'],
          description: 'Q1：A 与 B 是否同时成立、彼此定义、且无时间先后？',
        },
        q2: {
          type: 'string',
          required: true,
          enum: ['yes', 'no', 'unknown'],
          description: 'Q2：是否存在带时间延迟的相互影响（A→B→A，可能振荡）？',
        },
        q3: {
          type: 'string',
          required: true,
          enum: ['yes', 'no', 'unknown'],
          description: 'Q3：是否 A→B 严格先后且不可逆？',
        },
        q4: {
          type: 'string',
          required: true,
          enum: ['yes', 'no', 'unknown'],
          description: 'Q4：系统中是否同时存在多种因果结构（需拆子模块）？',
        },
        forbidden_actions: {
          type: 'array',
          required: false,
          description: '可选：禁止执行的动作名列表，策略不会把它们排进路径。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const orchestrator = ctx[SERVICE_ORCHESTRATOR];
        if (orchestrator === undefined) {
          throw new Error('CLIS 未就绪：clis.causalOrchestrator 服务不可用');
        }

        const result = await orchestrator.run(toProblem(args), {
          boundary: toBoundary(args),
          executor: {
            execute: async (invocation) => ({
              status: 'ok',
              detail: `已规划动作 ${invocation.action}（CLIS 只做推理与规划，不执行真实副作用）`,
            }),
          },
        });

        return {
          outcome: result.outcome,
          causal_type: result.classification?.causal_type,
          confidence: result.classification?.confidence,
          needs_exploration: result.classification?.needs_exploration,
          judgment_basis: (result.classification?.judgment_basis ?? [])
            .filter((item) => item.fired)
            .map((item) => `${item.rule_id}: ${item.effect ?? item.description}`),
          evidence: (result.classification?.evidence ?? []).map((item) => item.statement),
          signal_type: result.signal?.signal_type,
          signal_reason: result.signal?.reason,
          suggested_rollback: result.signal?.suggested_rollback,
          decision: result.decision,
          traces: result.state.traces,
          summary: result.reason,
        };
      },
    }),
  );

  // —— 工具 2：只做分类 ——
  ctx.tools.register(
    ctx.defineTool?.({
      name: 'clis_classify',
      description:
        '只判断因果类型，不生成策略也不执行。四类确定类型：structural_duality（同时成立、彼此定义、无先后）、cyclic（A→B→A 有时间延迟）、unidirectional（严格先后且不可逆）、nested（多种结构并存需拆子模块）；无法判断时返回 unknown 并给出候选假设，不强行归类。置信度上限 0.9，低于 0.7 标记需探索。',
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: '问题描述。',
        },
        q1: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q1：同时成立、彼此定义、无时间先后？' },
        q2: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q2：存在带时间延迟的相互影响？' },
        q3: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q3：A→B 严格先后且不可逆？' },
        q4: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q4：同时存在多种因果结构？' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        if (classifier === undefined) {
          throw new Error('CLIS 未就绪：clis.causalClassifier 服务不可用');
        }

        const result = await classifier.classify(toProblem(args));
        return {
          causal_type: result.causal_type,
          confidence: result.confidence,
          needs_exploration: result.needs_exploration,
          exploration_reason: result.exploration_reason,
          judgment_basis: (result.judgment_basis ?? [])
            .filter((item) => item.fired)
            .map((item) => `${item.rule_id}: ${item.effect ?? item.description}`),
          evidence: (result.evidence ?? []).map((item) => item.statement),
          candidate_hypotheses: result.candidate_hypotheses,
          sub_modules: result.sub_modules?.map((sub) => ({
            name: sub.name,
            causal_type: sub.classification.causal_type,
          })),
        };
      },
    }),
  );

  // —— 工具 3：只出候选路径 ——
  ctx.tools.register(
    ctx.defineTool?.({
      name: 'clis_plan',
      description:
        '只生成候选策略路径并排序，不执行。按「类型匹配度 0.4 + 预期效果 0.3 + 副作用风险 0.2 + 执行成本 0.1」排序，风险与成本以 (1-值) 进入故越低越优。返回每条路径的动作步骤、分数与名次，以及因边界被剔除的动作。',
      parameters: {
        description: { type: 'string', required: true, description: '问题描述。' },
        q1: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q1：同时成立、彼此定义、无时间先后？' },
        q2: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q2：存在带时间延迟的相互影响？' },
        q3: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q3：A→B 严格先后且不可逆？' },
        q4: { type: 'string', required: true, enum: ['yes', 'no', 'unknown'], description: 'Q4：同时存在多种因果结构？' },
        forbidden_actions: {
          type: 'array',
          required: false,
          description: '可选：禁止执行的动作名列表。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        const strategy = ctx[SERVICE_STRATEGY];
        if (classifier === undefined || strategy === undefined) {
          throw new Error('CLIS 未就绪：分类器或策略服务不可用');
        }

        const classification = await classifier.classify(toProblem(args));
        const paths = await strategy.match(classification, toBoundary(args));

        return {
          causal_type: classification.causal_type,
          confidence: classification.confidence,
          paths: paths.map((path) => ({
            rank: path.rank,
            path_id: path.path_id,
            variant: path.variant,
            family: path.family,
            score: path.score,
            executable: path.executable,
            summary: path.summary,
            steps: path.steps.map((step) => ({ action: step.action, params: step.params })),
            blocked_actions: path.blocked_actions,
            sub_paths: path.sub_paths?.map((sub) => ({
              path_id: sub.path_id,
              causal_type: sub.causal_type,
              variant: sub.variant,
            })),
          })),
        };
      },
    }),
  );
}

export { ANSWER_KEYS };
