import type { Context } from '@deepseek-ai/cordis';
import type { HealthFinding, HealthReport, CausalProblem, FourAnswers } from '@clis/clis-contracts';

/**
 * 互查调度：收集所有插件的健康探针结论，并**用因果判断分析其结构**。
 *
 * 为什么不是简单汇总列表（这是本模块的全部价值）：
 * 五个 WARN 逐条看是五个问题，可能只做五次修补；但如果它们其实是
 * 同一个环的不同切面，那五次修补都会失败 —— 该改的是环上的杠杆点。
 * 这正是 CLIS 相对普通 lint 的增量。
 *
 * 因此流程是三步：
 *   收集 findings → 按 code 归类 → 让分类器判断"这些问题的结构是什么"
 */

/** 一个可被检查的探针来源。 */
export interface ProbeSource {
  readonly plugin: string;
  readonly probe: () => Promise<HealthReport>;
}

/** 互查结论。 */
export interface ProbeOutcome {
  /** 各探针的原始结论。 */
  readonly reports: readonly HealthReport[];
  /** 按 code 聚合后的发现（同一 code 合并计数）。 */
  readonly grouped: readonly GroupedFinding[];
  /** 整体状态。 */
  readonly status: 'ok' | 'degraded' | 'failing';
  /** 结构性分析：这些问题的因果关系是什么。 */
  readonly analysis?: StructuralAnalysis;
  /** 探针自身失败（某插件探针抛错），单独列出以免被静默吞掉。 */
  readonly probeErrors: readonly { plugin: string; error: string }[];
}

/** 按 code 聚合后的发现。 */
export interface GroupedFinding {
  readonly code: string;
  readonly severity: HealthFinding['severity'];
  /** 出现次数；>1 说明同类问题反复。 */
  readonly count: number;
  /** 涉及的插件。 */
  readonly plugins: readonly string[];
  /** 代表性消息（取第一条）。 */
  readonly message: string;
  readonly hints: readonly string[];
}

/** 结构性分析结果。 */
export interface StructuralAnalysis {
  /** CLIS 判定的因果类型。 */
  readonly causalType: string;
  readonly confidence: number;
  /** 为什么这么判（四问作答，可复核）。 */
  readonly questions: FourAnswers;
  /** 一句话结论。 */
  readonly summary: string;
  /** 建议的方向（不是修复指令）。 */
  readonly direction?: string;
}

/**
 * 收集并分析所有探针。
 *
 * 探针抛错**不会让整个互查失败**：转成 probeErrors 记录，
 * 因为"某个插件的探针坏了"本身就是需要被发现的问题。
 */
export class HealthSupervisor {
  /**
   * @param ctx 插件上下文（用于取分类器与各探针）。
   * @param sources 探针来源列表。
   */
  constructor(
    private readonly ctx: Context,
    private readonly sources: readonly ProbeSource[],
  ) {}

  /**
   * 跑一次互查。
   *
   * @returns 汇总结论与结构分析。
   */
  async run(): Promise<ProbeOutcome> {
    const reports: HealthReport[] = [];
    const probeErrors: { plugin: string; error: string }[] = [];

    for (const source of this.sources) {
      try {
        reports.push(await source.probe());
      } catch (error) {
        probeErrors.push({
          plugin: source.plugin,
          error: String((error as Error)?.message ?? error).slice(0, 200),
        });
      }
    }

    const grouped = groupFindings(reports);
    const status = overallStatus(reports, probeErrors);
    const analysis = await this.analyse(grouped, probeErrors);

    return { reports, grouped, status, probeErrors, ...(analysis !== undefined ? { analysis } : {}) };
  }

  /**
   * 让分类器判断这些问题的因果结构。
   *
   * 判据是**从聚合结果推断**的，不是人工写死的：
   * - 同一 code 反复出现（count>1）⇒ 有反馈环：出现→修补→再出现
   * - 多个 code 指向同一 location ⇒ 互为定义/同一根因
   * - 探针自身抛错 ⇒ 需要先修观测能力，不是业务问题
   *
   * @param grouped 聚合后的发现。
   * @param probeErrors 探针失败记录。
   * @returns 结构分析；无法判断时 undefined。
   */
  private async analyse(
    grouped: readonly GroupedFinding[],
    probeErrors: readonly { plugin: string; error: string }[],
  ): Promise<StructuralAnalysis | undefined> {
    if (grouped.length === 0 && probeErrors.length === 0) return undefined;

    // 用 ctx.get() 安全取服务：Context 代理对未 inject 的键会抛错
    // （实测 cannot get property "clis.causalFeedback" without inject）。
    // 互查调度器只做编排，不该把分类器以外的服务也纳入 inject。
    const getter = (this.ctx as unknown as { get?: (name: string) => unknown }).get;
    const classifier =
      typeof getter === 'function'
        ? (getter.call(this.ctx, 'clis.causalClassifier') as
            | {
                classify(problem: CausalProblem): Promise<{
                  causal_type: string;
                  confidence: number;
                }>;
              }
            | undefined)
        : undefined;
    if (classifier === undefined) return undefined;

    const errorCount = grouped.filter((item) => item.severity === 'error').length;

    // 从聚合结果推断四问作答 —— "自动互查"的核心翻译环节。
    //
    // ## 两条必须遵守的规则
    //
    // **规则一：四问必须互斥。** 分类器的 R3 规则把"Q1..Q3 多个 yes"判为
    // 结构冲突 → 强行归为 nested。人工作答不会同时选两个（那自相矛盾），
    // 但自动翻译时多个特征可能同时成立。故按优先级取一个。
    //
    // **规则二：Q2（回路）不能由"轮内重复"推断 —— 这是真机踩到的 bug。**
    // workbuddy-channels 的两条车道各报一次同一条规则，`count=2`，
    // 首版据此填 Q2=yes → 判为"存在反馈环，逐条修补无效"。
    // 但那只是**同一条规则在两处触发**，与"修了又回来"完全无关。
    //
    // 回路的唯一正确判据是**跨轮持续**：上一轮报过、这一轮还在。
    // 那个信息只有调用方（掌握历史）才知道，故由 `deriveNotices` 用
    // `persisting` 参数单独判定，这里一律填 'no'。
    const hasProbeFailure = probeErrors.length > 0;
    const hasSameOrigin = grouped.length > 1 && sameLocation(grouped);
    const isSinglePoint = grouped.length === 1 && !hasProbeFailure;

    const questions: FourAnswers = {
      q1_simultaneous_mutual_definition: !hasProbeFailure && hasSameOrigin ? 'yes' : 'no',
      // 见规则二：回路只能由跨轮数据判定，此处不作断言
      q2_delayed_mutual_influence: 'no',
      q3_strict_irreversible_order: isSinglePoint ? 'yes' : 'no',
      // Q4 多结构并存：既有探针故障又有业务问题
      q4_coexisting_causal_structures:
        probeErrors.length > 0 && grouped.length > 0 ? 'yes' : 'no',
    };

    try {
      const result = await classifier.classify({
        description: `插件体检发现 ${grouped.length} 类问题（${errorCount} 个 error）`,
        answers: questions,
      });

      return {
        causalType: result.causal_type,
        confidence: result.confidence,
        questions,
        summary: summarise(result.causal_type, grouped, probeErrors),
        ...(directionFor(result.causal_type) !== undefined
          ? { direction: directionFor(result.causal_type) }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
}

/** 判断多个 finding 是否指向同一位置。 */
function sameLocation(grouped: readonly GroupedFinding[]): boolean {
  const locations = new Set(grouped.map((item) => item.plugins.join(',')));
  return locations.size === 1;
}

/**
 * 按 code 聚合 findings。
 *
 * @param reports 各探针结论。
 * @returns 聚合结果，按严重程度排序。
 */
export function groupFindings(reports: readonly HealthReport[]): GroupedFinding[] {
  const table = new Map<string, { findings: HealthFinding[]; plugins: Set<string> }>();

  for (const report of reports) {
    for (const finding of report.findings) {
      const slot = table.get(finding.code) ?? { findings: [], plugins: new Set<string>() };
      slot.findings.push(finding);
      slot.plugins.add(report.plugin);
      table.set(finding.code, slot);
    }
  }

  const rank = { error: 0, warn: 1, info: 2 } as const;

  return [...table.entries()]
    .map(([code, slot]) => {
      const worst = slot.findings.reduce<HealthFinding['severity']>(
        (current, item) => (rank[item.severity] < rank[current] ? item.severity : current),
        'info',
      );
      return {
        code,
        severity: worst,
        count: slot.findings.length,
        plugins: [...slot.plugins],
        message: slot.findings[0]?.message ?? '',
        hints: [...new Set(slot.findings.map((item) => item.hint).filter((hint): hint is string => hint !== undefined))],
      };
    })
    .sort((left, right) => rank[left.severity] - rank[right.severity]);
}

/**
 * 推导整体状态。
 *
 * @param reports 各探针结论。
 * @param probeErrors 探针失败。
 * @returns ok / degraded / failing。
 */
function overallStatus(
  reports: readonly HealthReport[],
  probeErrors: readonly { plugin: string; error: string }[],
): ProbeOutcome['status'] {
  if (probeErrors.length > 0) return 'failing';
  if (reports.some((item) => item.status === 'failing')) return 'failing';
  if (reports.some((item) => item.status === 'degraded')) return 'degraded';
  return 'ok';
}

/** 生成一句话结构结论。 */
function summarise(
  causalType: string,
  grouped: readonly GroupedFinding[],
  probeErrors: readonly { plugin: string; error: string }[],
): string {
  switch (causalType) {
    // 注意：这里不再声称"反复出现" —— 轮内数据判不出回路（见 analyse 的
    // 规则二）。回路由 deriveNotices 用跨轮数据单独报 `structure.recurring`。
    case 'cyclic':
      return `这 ${grouped.length} 类问题可能相互牵动，逐条修未必有效`;
    case 'structural_duality':
      return `这 ${grouped.length} 类问题同属一个插件或一处位置，可能是同一个产生环节的不同表现`;
    case 'nested':
      return `存在多种结构并存${probeErrors.length > 0 ? '（含探针自身故障）' : ''}：需拆开分别处理，先修观测能力再看业务问题`;
    case 'unidirectional':
      return '这是单点问题，直接处理即可';
    default:
      return `发现 ${grouped.length} 类问题，但信息不足以判断结构`;
  }
}

/** 按因果类型给出方向性建议（不是修复指令）。 */
function directionFor(causalType: string): string | undefined {
  switch (causalType) {
    case 'cyclic':
      // 措辞刻意保守：轮内数据判不出回路，真正的回路判据在
      // deriveNotices 的跨轮 `structure.recurring`。
      return '这些问题可能相互牵动，逐条修未必有效；先看它们是否共享同一个产生环节';
    case 'structural_duality':
      // 多类问题出自同一插件只是**弱证据**：可能是同一个产生环节的不同表现，
      // 也可能彼此无关。故给的是"先查同源性"，不是"两边一起改"那种断言。
      return '先确认这几类问题是否出自同一个产生环节：若同源，只改其中一类剩下的仍在';
    case 'nested':
      return '先修探针/观测能力，再处理业务问题：观测坏了会掩盖真实病灶';
    case 'unidirectional':
      return '定位最早可干预的那个因，一次改到';
    default:
      return undefined;
  }
}
