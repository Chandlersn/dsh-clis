import type { Context } from '@deepseek-ai/cordis';
import type {
  CausalProblem,
  FourAnswers,
  KnownCausalType,
  StrategyBoundary,
} from '@clis/clis-contracts';

import { getDefineTool } from './cordis-shim';
import { toToolJson } from './tool-json';
import { ClisHistoryStore, fingerprint } from './history';

/**
 * CLIS 的工具入口 —— 只做**转发**，不含任何判据。
 *
 * 为什么需要这一层：四个组件注册的是 Cordis **服务**（进程内），
 * 而 agent 只能通过**工具**触达。这一层把工具调用转成服务调用。
 *
 * 职责边界不变：
 * - 分类在 clis.causalClassifier
 * - 匹配在 clis.causalStrategy
 * - 反馈在 clis.causalFeedback
 * - 编排在 clis.causalOrchestrator
 * 本文件只做参数整形与结果渲染。
 *
 * 注意：`defineTool` 必须用**宿主那一份**（见 cordis-shim），
 * 否则宿主认不出 ToolDefinition。
 */

/** 宿主 `ctx.tools` 的最小可用形状。 */
interface HostToolRuntime {
  register(definition: unknown): () => void;
}

/**
 * 取上下文的工具注册表。
 *
 * `ctx.tools` 由宿主 `@deepseek-ai/dsh-tools` 增强到 Context 上，
 * 本包不依赖它的类型包，故此处做一次窄化断言。
 *
 * @param ctx 插件上下文。
 * @returns 工具注册表。
 */
function toolRuntime(ctx: Context): HostToolRuntime {
  return (ctx as unknown as { tools: HostToolRuntime }).tools;
}

const SERVICE_CLASSIFIER = 'clis.causalClassifier';
const SERVICE_STRATEGY = 'clis.causalStrategy';
const SERVICE_ORCHESTRATOR = 'clis.causalOrchestrator';


/** 四问参数名到契约字段的映射。 */
const FOUR_QUESTION_PROPS = {
  q1: 'Q1：A 与 B 是否同时成立、彼此定义、且无时间先后？',
  q2: 'Q2：是否存在带时间延迟的相互影响（A→B→A，可能振荡）？',
  q3: 'Q3：是否 A→B 严格先后且不可逆？',
  q4: 'Q4：系统中是否同时存在多种因果结构（需拆子模块）？',
} as const;

type QuestionKey = keyof typeof FOUR_QUESTION_PROPS;

/** 工具入参里的四问作答形状。 */
type TriStateArg = 'yes' | 'no' | 'unknown';

/**
 * 把工具入参整形成 CausalProblem。
 *
 * 入参已由宿主按 schema 校验（四项 required + enum），
 * 此处只做一次窄化，把 `Record<string, unknown>` 收敛到契约类型。
 *
 * @param raw 工具入参。
 * @returns CausalProblem。
 */
function toProblem(raw: Record<string, unknown>): CausalProblem {
  const args = raw as {
    description: string;
    q1: TriStateArg;
    q2: TriStateArg;
    q3: TriStateArg;
    q4: TriStateArg;
  };

  const answers: FourAnswers = {
    q1_simultaneous_mutual_definition: args.q1,
    q2_delayed_mutual_influence: args.q2,
    q3_strict_irreversible_order: args.q3,
    q4_coexisting_causal_structures: args.q4,
  };
  return { description: args.description, answers };
}

/**
 * 把工具入参里的 forbidden 动作整形成 StrategyBoundary。
 *
 * @param raw 工具入参。
 * @returns StrategyBoundary。
 */
function toBoundary(raw: Record<string, unknown>): StrategyBoundary {
  const forbidden = raw.forbidden_actions as readonly string[] | undefined;
  return { forbidden_actions: forbidden ?? [] };
}

/** 四问参数的共享 schema 片段。 */
function questionParams(): Record<string, object> {
  const params: Record<string, object> = {};
  for (const [key, text] of Object.entries(FOUR_QUESTION_PROPS)) {
    params[key] = {
      type: 'string',
      required: true,
      enum: ['yes', 'no', 'unknown'],
      description: text,
    };
  }
  return params;
}

/**
 * 注册 CLIS 的三个工具。
 *
 * @param ctx 已具备 tools 服务的上下文。
 */
export function registerTools(ctx: Context): void {
  const defineTool = getDefineTool();
  const history = new ClisHistoryStore();

  // —— clis_run：完整闭环 ——
  toolRuntime(ctx).register(
    defineTool({
      name: 'clis_run',
      description:
        '按因果类型处理一个问题：先判断因果类型（结构对偶/循环/单向/嵌套/未知），再匹配策略、生成候选路径，执行后依据反馈信号决定继续、换路径或回退。适合需要先辨明因果结构再动手的问题，例如反馈回路该怎么干预、单向依赖能否逆转、两个概念是否互为定义。把上一次的真实结果通过 last_outcome 回填，它就能判断"上次那个假设是不是错了"——反复无效时会给出 type_misjudged 并建议换一种因果假设。',
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: '问题描述，一句话说清 A 与 B 的关系。',
        },
        ...questionParams(),
        forbidden_actions: {
          type: 'array',
          description: '可选：禁止执行的动作名列表，策略不会把它们排进路径。',
          items: { type: 'string' },
        },
        last_outcome: {
          type: 'string',
          enum: ['achieved', 'failed', 'not_tried'],
          description:
            '可选：上一次按本工具建议动手后的真实结果。achieved=问题解决/指标改善；failed=做了但没效果或更糟；not_tried=还没动手（首次分析时用）。不填视为未记录，反馈将无法判定类型误判。',
        },
        last_detail: {
          type: 'string',
          description: '可选：上一轮实际发生了什么（一句话）。会随着结果一起归档，供下次判断时回看。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(rawArgs: Record<string, unknown>) {
        const orchestrator = ctx[SERVICE_ORCHESTRATOR];
        if (orchestrator === undefined) {
          throw new Error('CLIS 未就绪：clis.causalOrchestrator 服务不可用');
        }

        const problem = toProblem(rawArgs);
        const key = fingerprint(problem.description, problem.answers);
        const prior = await history.read(key);

        const lastOutcome = rawArgs.last_outcome as 'achieved' | 'failed' | 'not_tried' | undefined;

        // 若调用方回填了上次的真实结果，先把它归档。
        //
        // 只归档**真实结果**（last_outcome 回填），绝不归档桩执行器产生的信号：
        // 桩恒返回 ok，其信号必为 effective —— 记进去会污染历史，
        // 让"反复偏离"永远判不出来。
        //
        // 信号归类遵循契约语义（见 clis-contracts/feedback.ts）：
        // - achieved            → effective（结果符合成功标准）
        // - failed 且此前无失败  → ineffective（偏离了，但类型假设未必错）
        // - failed 且此前已失败  → type_misjudged（**反复**偏离，才与假设矛盾）
        // 一次失败不足以判定类型错 —— 过早升级会误导调用方换错假设。
        if (lastOutcome !== undefined && lastOutcome !== 'not_tried' && prior !== undefined) {
          const previousType = prior.entries.at(-1)?.causal_type ?? 'unknown';
          // 只数**真实动手后失败**的次数：baseline（未动手）那条 ineffective 不算，
          // 否则第一次失败就会被误升级成 type_misjudged。
          const priorFailures = prior.entries.filter(
            (entry) =>
              entry.baseline !== true &&
              (entry.signal_type === 'ineffective' || entry.signal_type === 'type_misjudged'),
          ).length;
          const signalOnFailure = priorFailures > 0 ? 'type_misjudged' : 'ineffective';

          await history.append(key, problem.description, {
            causal_type: previousType === 'unknown' ? 'unknown' : (previousType as KnownCausalType),
            signal_type: lastOutcome === 'achieved' ? 'effective' : signalOnFailure,
            achieved: lastOutcome === 'achieved',
            detail: (rawArgs.last_detail as string | undefined) ?? `回填结果：${lastOutcome}`,
            at: new Date().toISOString(),
          });
        }

        const result = await orchestrator.run(problem, {
          boundary: toBoundary(rawArgs),
          executor: {
            // 执行器只回执"这一步能否做到"，不代表"问题是否解决"——
            // 后者由调用方通过 last_outcome 如实回填。
            execute: async (invocation) => ({
              status: 'ok',
              detail: `已规划动作 ${invocation.action}（CLIS 只做推理与规划，不产生真实副作用）`,
            }),
          },
        });

        // 首次见到这个问题时，记一条"尚未动手"的基线，
        // 让下次能知道当时假设的是什么类型。signal 记为 ineffective（未验证），
        // 不写 effective —— 没动手不等于有效。
        if (prior === undefined) {
          await history.append(key, problem.description, {
            causal_type: (result.classification?.causal_type ?? 'unknown') as KnownCausalType | 'unknown',
            signal_type: 'ineffective',
            achieved: false,
            baseline: true,
            detail: '本轮仅做判断与规划，尚未动手',
            at: new Date().toISOString(),
          });
        }

        const priorSignalsAfter = ClisHistoryStore.signalsFor(
          await history.read(key),
          (result.classification?.causal_type ?? 'unknown') as string,
        );
        const priorRollbacksAfter = (await history.read(key))?.entries.filter(
          (entry) => entry.signal_type === 'type_misjudged',
        ).length ?? 0;

        return toToolJson({
          problem_key: key,
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
          history: {
            times_seen: (await history.read(key))?.entries.length ?? 0,
            prior_signals: priorSignalsAfter,
            prior_rollbacks: priorRollbacksAfter,
            hint:
              priorRollbacksAfter > 0
                ? '此前该类型假设已判过误判，考虑换一种因果假设重新提问'
                : '下次动手后请回填 last_outcome，这样系统才能判断这次假设是否成立',
          },
        });
      },
    }),
  );

  // —— clis_classify：只判断类型 ——
  toolRuntime(ctx).register(
    defineTool({
      name: 'clis_classify',
      description:
        '只判断因果类型，不生成策略也不执行。四类确定类型：structural_duality（同时成立、彼此定义、无先后）、cyclic（A→B→A 有时间延迟）、unidirectional（严格先后且不可逆）、nested（多种结构并存需拆子模块）；无法判断时返回 unknown 并给候选假设，不强行归类。置信度上限 0.9，低于 0.7 标记需探索。',
      parameters: {
        description: { type: 'string', required: true, description: '问题描述。' },
        ...questionParams(),
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: Record<string, unknown>) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        if (classifier === undefined) {
          throw new Error('CLIS 未就绪：clis.causalClassifier 服务不可用');
        }

        const result = await classifier.classify(toProblem(args));
        return toToolJson({
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
        });
      },
    }),
  );

  // —— clis_plan：只出候选路径 ——
  toolRuntime(ctx).register(
    defineTool({
      name: 'clis_plan',
      description:
        '只生成候选策略路径并排序，不执行。按「类型匹配度 0.4 + 预期效果 0.3 + 副作用风险 0.2 + 执行成本 0.1」排序，风险与成本以 (1-值) 进入故越低越优。返回每条路径的动作步骤、分数与名次，以及因边界被剔除的动作。',
      parameters: {
        description: { type: 'string', required: true, description: '问题描述。' },
        ...questionParams(),
        forbidden_actions: {
          type: 'array',
          description: '可选：禁止执行的动作名列表。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: Record<string, unknown>) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        const strategy = ctx[SERVICE_STRATEGY];
        if (classifier === undefined || strategy === undefined) {
          throw new Error('CLIS 未就绪：分类器或策略服务不可用');
        }

        const classification = await classifier.classify(toProblem(args));
        const paths = await strategy.match(classification, toBoundary(args));

        return toToolJson({
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
        });
      },
    }),
  );
}

export type { QuestionKey };
