import type { Context } from '@deepseek-ai/cordis';
import type {
  CausalProblem,
  FourAnswers,
  KnownCausalType,
  StrategyBoundary,
} from '@clis/clis-contracts';

import { getDefineTool } from './cordis-shim';
import { SemiAutoExecutor } from './executor';
import { deriveNotices, HealthNotifier, shapeForAgent } from './health-notifier';
import { readSeenState, reconcileFindings, writeSeenState } from './health-seen';
import { autoSources, buildScope, listPlugins } from './plugin-scope';
import { HealthSupervisor } from './health-supervisor';
import type { ProbeSource } from './health-supervisor';
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
export function registerTools(
  ctx: Context,
  healthSources: () => ProbeSource[] = () => [],
): void {
  const defineTool = getDefineTool();
  const history = new ClisHistoryStore();

  // —— clis_run：完整闭环 ——
  toolRuntime(ctx).register(
    defineTool({
      name: 'clis_run',
      description:
        '当改动反复无效、越调越糟、指标来回震荡，或两个因素分不清谁因谁果时，先判断因果结构再动手。因为"单向因果"和"反馈回路"需要完全相反的处理：前者该溯源到最早可干预的因，后者在环上硬推会加剧震荡。返回因果类型、判断依据，以及按该类型排序的策略路径。把上次动手的真实结果回填到 last_outcome，反复无效时它会判定类型假设有误并建议换一种因果解释。',
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: '一句话说清 A 与 B 的关系，以及你观察到的现象（如"调高价格想抑制需求，需求短暂下降后又反弹"）。',
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
        allow_writes: {
          type: 'array',
          description:
            '可选：显式放行的**写动作**白名单。执行器默认只自动执行只读动作（测量/追溯/枚举/定位）；写动作（施加干预/调参/注入阻尼/改延迟/覆盖旧因）一律拦下。只有你明确列出某个写动作，它才会被执行。',
          items: { type: 'string' },
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

        // 把已归档的真实历史喂给编排器 → 它转交反馈服务。
        //
        // 这一步是闭环能否"自我纠错"的关键：反馈服务无状态，只看得到本轮；
        // 不传历史时 `type_misjudged`（要求**反复**偏离）永远不可能触发。
        //
        // 只传**同一类型假设下**的信号：换了假设，旧信号不再构成对当前假设的反证。
        // 类型假设要等分类才知道，故先分类一次（纯函数，无副作用、很便宜）。
        const preClassified = await ctx[SERVICE_CLASSIFIER]?.classify(problem);
        const priorSignals = ClisHistoryStore.signalsFor(
          prior,
          (preClassified?.causal_type ?? 'unknown') as string,
        );
        const priorRollbacks = ClisHistoryStore.rollbacksFor(
          prior,
          (preClassified?.causal_type ?? 'unknown') as string,
        );

        // 半自动执行器：只读动作自动放行，写动作拦下等授权。
        //
        // 为什么不再用"恒返回 ok 的桩"：桩会让反馈永远判 effective，
        // 闭环失去意义。半自动执行器让只读观测真实发生（虽然观测数据
        // 仍需 agent 采集），并把写动作的"未授权"如实记为失败信号 ——
        // 这样反馈能看到真实阻碍，而不是被假成功掩盖。
        const allowWrites = rawArgs.allow_writes as readonly string[] | undefined;
        const executor = new SemiAutoExecutor({ allowWrites });

        const result = await orchestrator.run(problem, {
          boundary: toBoundary(rawArgs),
          executor,
          ...(priorSignals.length > 0 || priorRollbacks > 0
            ? {
                history: {
                  previous_signals: priorSignals,
                  ...(priorRollbacks > 0 ? { rollback_count: priorRollbacks } : {}),
                },
              }
            : {}),
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
        const afterRecord = await history.read(key);
        const priorRollbacksAfter = ClisHistoryStore.rollbacksFor(
          afterRecord,
          (result.classification?.causal_type ?? 'unknown') as string,
        );
        /** 真实动手后的失败累计次数（不含基线）。 */
        const priorFailuresAfter = ClisHistoryStore.failures(afterRecord);

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
          // 半自动执行器的实际动作：只读放行了哪些、写动作被拦下哪些。
          // 这是"半自动"的可见凭据 —— 你能看到它做了什么、没做什么。
          actions: {
            observed: executor.observations,
            blocked_writes: executor.pendingWrites,
            note:
              executor.pendingWrites.length > 0
                ? `有 ${executor.pendingWrites.length} 个写动作因未授权而未执行。如需执行，请在 allow_writes 里显式列出动作名。`
                : '本轮无写动作，或已在 allow_writes 中放行。',
          },
          // 关键区分：`signal_type` 判的是**本轮规划**（桩执行器恒 ok ⇒ 恒 effective），
          // 而 `last_outcome` 是**你实际动手**的结果。历史里累计多次失败时，
          // 单看 effective 会误以为问题解决了 —— 这里显式点明，并给出该做什么。
          guidance:
            priorFailuresAfter === 0
              ? '本轮仅给出规划；动手后请回填 last_outcome，系统才能判断这次假设是否成立'
              : priorFailuresAfter >= 2
                ? `同一假设已累计 ${priorFailuresAfter} 次失败：不要再沿这条假设加码，换一种因果类型重新提问（例如 q2 若其实是 yes，那就是回路而非单向）`
                : '上一次失败了：这次动手后务必回填 last_outcome，第二次失败就足以判定类型假设有误',
          history: {
            times_seen: (await history.read(key))?.entries.length ?? 0,
            prior_signals: priorSignalsAfter,
            prior_rollbacks: priorRollbacksAfter,
            prior_failures: priorFailuresAfter,
            plan_outcome_note:
              '注意 outcome/signal_type 反映的是「本轮规划是否顺利执行」，不代表现实问题已解决；现实结果取决于你回填的 last_outcome',
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
        '只回答"这是什么因果结构"，不给建议也不动手。用于你想先确认结构再决定怎么处理、或需要向用户解释"为什么这里不能用常规办法"。四种结果：structural_duality（两者同时成立、彼此定义）、cyclic（有延迟的相互影响，会震荡）、unidirectional（严格先后且不可逆）、nested（多种结构并存）；信息不足时返回 unknown 并列出候选假设，不硬猜。',
      parameters: {
        description: { type: 'string', required: true, description: '一句话说清 A 与 B 的关系。' },
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
        '只列"这种事有哪几种做法、各自代价如何"，不执行也不推荐唯一答案。用于你想给用户几个有依据的选项、或想先看清代价再决定。按类型匹配度、预期效果、副作用风险、执行成本四项加权排序；可指定禁止使用的动作，它们不会出现在任何路径里。',
      parameters: {
        description: { type: 'string', required: true, description: '一句话说清 A 与 B 的关系。' },
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

  // —— clis_probe：系统级插件监督 ——
  toolRuntime(ctx).register(
    defineTool({
      name: 'clis_probe',
      description:
        '系统级插件监督：枚举宿主全部插件，收集各自健康探针的原始信号，用因果结构分析判断"这些散乱问题之间是什么关系"，并只投递对方自查报不出来的结论（结构诊断 + 覆盖缺口）。**不转发对方自己已经显示的逐条警告** —— 那些在各自面板里已有，重复搬运只是噪音。用于回答"某个插件反复出问题、修了又回来，到底是几个问题还是一个环"这类跨问题判断。',
      parameters: {
        only: {
          type: 'array',
          description: '可选：只监督这些插件 id；省略则枚举宿主全部活动插件。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(rawArgs: Record<string, unknown>) {
        // —— 第一步：枚举整个系统的插件列表（不依赖任何写死的名单）——
        const plugins = listPlugins(ctx);
        const explicit = healthSources();

        // —— 第二步：自动生成监督来源 ——
        //
        // 这是本机制可扩展的关键（用户 2026-10-26 指出）：
        // 若只能等插件自己上报，新装的插件永远不会被知道。
        // 现在分两层：
        // - 自动层：从 loader 元数据推导（装载状态/依赖满足），插件无需配合；
        // - 协作层：插件导出 healthProbe 或显式注册 → 更丰富的领域信号。
        const auto = autoSources(ctx, plugins, explicit);
        const { activeTotal } = buildScope(plugins, explicit);

        const only = rawArgs.only as readonly string[] | undefined;
        const sources =
          only === undefined
            ? auto.sources
            : auto.sources.filter((item) => only.some((id) => id === item.plugin));

        const supervision = {
          active_plugins: activeTotal,
          user_plugins: auto.total,
          supervised: sources.length,
          domain_probes: auto.domainCovered,
          structural_only: auto.structuralOnly,
        };

        if (sources.length === 0) {
          return toToolJson({
            status: 'ok',
            supervision,
            message: '没有可监督的非内建插件',
            notices: [],
          });
        }

        const supervisor = new HealthSupervisor(ctx, sources);
        const outcome = await supervisor.run();

        // —— 第二步：读历史，算出"跨轮仍在"的问题 ——
        //
        // 这是**回路的唯一正确判据**：上一轮报过、这一轮还在。
        // 轮内出现多次（同一规则在两处触发）看着像"反复"，实则无关 ——
        // 真机上就因此把"两条车道各报一次限流"误判成了"反馈环"。
        const previous = await readSeenState();
        const presentCodes = new Set(outcome.grouped.map((item) => item.code));
        const persisting = Object.values(previous.findings)
          .filter((item) => presentCodes.has(item.code))
          .map((item) => item.code);

        // —— 第三步：只提炼结构诊断，不转发对方的逐条 findings ——
        //
        // memory-manager 的 R14/R3 在它自己面板里已有，转发回它自己的
        // 收件箱只是重复。CLIS 的增量是"这些警告是什么结构"。
        const notices = deriveNotices(outcome, [], persisting);

        // —— 第四步：去重 + 判"对方修了没" ——
        // 判据同样是"下一轮该 code 是否还在"，不依赖对方回报。
        const escalateAfter = 2;
        const dispositionInput = notices.map((notice) => ({
          code: notice.code,
          severity: notice.severity,
          message: notice.message,
          plugins: notice.plugins,
          count: notice.evidence.length,
        }));
        const { dispositions, next } = reconcileFindings(
          dispositionInput,
          previous,
          escalateAfter,
        );
        await writeSeenState(next);

        const notifier = new HealthNotifier(ctx);
        const notified = notifier.notify(notices);
        const shaped = shapeForAgent(notified, outcome.grouped);

        return toToolJson({
          status: outcome.status,
          // 监督覆盖面：用户一眼看到"全系统有多少插件、多少在被监督"
          supervision,
          probed: sources.map((item) => item.plugin),
          probe_errors: outcome.probeErrors,
          // 结构判断（CLIS 的核心产出）
          analysis: outcome.analysis,
          // 注意：分组计数保留，但它只是**证据**，不是投递项
          evidence: outcome.grouped.map((item) => ({
            code: item.code,
            count: item.count,
            plugins: item.plugins,
          })),
          notices: shaped,
          dispositions: dispositions.map((item) => ({
            code: item.code,
            disposition: item.disposition,
            rounds: item.roundsUnresolved,
          })),
        });
      },
    }),
  );
}

export type { QuestionKey };
