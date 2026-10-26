import type { Context } from '@deepseek-ai/cordis';

import type { DispositionedFinding } from './health-seen';
import type { ProbeOutcome } from './health-supervisor';

/**
 * 结构诊断的投递 —— CLIS 唯一有独立价值的东西。
 *
 * ## 为什么要重做（2026-10-26 用户指出）
 *
 * 早先的实现把 memory-manager 的 memory_check 结果**原样转发**回它自己
 * 的收件箱。但那些警告在它自己面板的「总览」里已经显示了 ——
 * 同一个问题出现两次，收件箱没有独立增量，纯属噪音。
 *
 * 用户的原话：「clis探测的应该是除了记忆管理自己体验出的问题之外的
 * 问题，不然就重复了，转发进邮箱显示也没多大意义」。
 *
 * ## 正确的分工
 *
 * | 谁 | 提供什么 | 为什么 |
 * |---|---|---|
 * | 对方插件自查 | 逐条问题清单 | 它最清楚自己的规则细节 |
 * | CLIS | 这些问题的**结构** | 跨问题/跨插件的判断，对方给不了 |
 *
 * 所以投递的东西分两类，语义完全不同：
 *
 * 1. **结构诊断**（`structure.*`）：这几条警告是同一个环的切面 /
 *    互为定义 / 需要拆开 —— 这是收件箱该收的。
 * 2. **覆盖缺口**（`coverage.*`）：某个插件没有探针、或探针坏了 ——
 *    这是 CLIS 独有视角（它看得见整个插件列表），对方也报不出来。
 *
 * 对方的原始 findings **一律不进收件箱**，只作为结构分析的输入。
 */

/** 通报事件名。对方用 `ctx.on('clis/health-finding', ...)` 订阅。 */
export const HEALTH_FINDING_EVENT = 'clis/health-finding';

/** 投递项：一条结构诊断或覆盖缺口。 */
export interface StructuralNotice {
  /** 稳定代号，用于去重。形如 `structure.cyclic` / `coverage.no-probe`。 */
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'error';
  /** 一句话说清**结构**，不是复述某条警告。 */
  readonly message: string;
  /** 建议的方向（不是修复指令）。 */
  readonly hint?: string;
  /** 涉及哪些插件（结构问题常横跨多个）。 */
  readonly plugins: readonly string[];
  /** 支撑这个结论的证据摘要（让用户能复核，但它不是主体）。 */
  readonly evidence: readonly string[];
  /** 该把这条发给谁：诊断涉及的具体插件；空表示只有 agent 需要知道。 */
  readonly targets: readonly string[];
}

/** 通报结果。 */
export interface NotifyOutcome {
  /** 成功发给他方插件的条数。 */
  readonly notifiedPlugins: number;
  /** 需要 agent/用户看的条目。 */
  readonly forUser: readonly StructuralNotice[];
}

/**
 * 从体检结果提炼结构诊断。
 *
 * 关键：**只产出对方自查报不出来的结论**。
 *
 * @param outcome 互查结果。
 * @param uncovered 没有探针的活动插件。
 * @returns 结构诊断列表。
 */
export function deriveNotices(
  outcome: ProbeOutcome,
  uncovered: readonly string[],
): StructuralNotice[] {
  const notices: StructuralNotice[] = [];

  // —— 1. 覆盖缺口：某插件没有探针，用户以为它在被监督其实没有 ——
  if (uncovered.length > 0) {
    notices.push({
      code: 'coverage.no-probe',
      severity: 'warn',
      message: `${uncovered.length} 个活动插件没有提供健康探针，它们的内部问题不会被任何机制发现`,
      hint: '这不是这些插件坏了，而是它们处在了监督盲区；要给它们加一个 probe() 才会被纳入',
      plugins: uncovered,
      evidence: uncovered.map((id) => `未覆盖：${id}`),
      targets: uncovered,
    });
  }

  // —— 2. 探针自身故障：观测能力坏了，比业务问题更该先说 ——
  if (outcome.probeErrors.length > 0) {
    notices.push({
      code: 'structure.probe-broken',
      severity: 'error',
      message: `${outcome.probeErrors.length} 个插件的探针自身抛错，这意味着它们的问题目前完全不可观测`,
      hint: '先修探针再看业务问题：观测坏了会把真实病灶一起盖住',
      plugins: outcome.probeErrors.map((item) => item.plugin),
      evidence: outcome.probeErrors.map((item) => `${item.plugin}: ${item.error}`),
      targets: outcome.probeErrors.map((item) => item.plugin),
    });
  }

  // —— 3. 结构诊断：这些警告之间的关系，这是 CLIS 的核心增量 ——
  const analysis = outcome.analysis;
  if (analysis !== undefined && outcome.grouped.length > 0) {
    const evidence = outcome.grouped.map(
      (item) => `${item.code} ×${item.count}（${item.plugins.join('、')}）`,
    );

    // 只有成规模的问题才值得说结构：单条问题直接修就行，说"结构"是过度解读
    const worthStructural = outcome.grouped.length > 1 || outcome.grouped.some((i) => i.count > 1);

    if (worthStructural) {
      notices.push({
        code: `structure.${analysis.causalType}`,
        severity: analysis.confidence >= 0.7 ? 'warn' : 'info',
        message: analysis.summary,
        ...(analysis.direction !== undefined ? { hint: analysis.direction } : {}),
        plugins: [...new Set(outcome.grouped.flatMap((item) => item.plugins))],
        evidence,
        targets: [...new Set(outcome.grouped.flatMap((item) => item.plugins))],
      });
    }
  }

  return notices;
}

/**
 * 通报器：把结构诊断发给涉及的插件，并交一份给 agent。
 *
 * 注意与旧实现的关键差别：**不再转发对方的逐条 findings**。
 * 那些在对方自己的面板里已经有了。
 */
export class HealthNotifier {
  /**
   * @param ctx 插件上下文（用于 emit 事件）。
   * @param origin 本插件名。
   */
  constructor(
    private readonly ctx: Context,
    private readonly origin = 'dsh-clis',
  ) {}

  /**
   * 投递结构诊断。
   *
   * @param notices 结构诊断。
   * @returns 通报结果。
   */
  notify(notices: readonly StructuralNotice[]): NotifyOutcome {
    let notifiedPlugins = 0;

    for (const notice of notices) {
      try {
        // Cordis emit 是同步派发：订阅了就能收到，未订阅也不报错。
        // 通报是信息不是命令 —— 强制会让插件间产生紧耦合。
        (this.ctx as unknown as { emit: (name: string, payload: unknown) => void }).emit(
          HEALTH_FINDING_EVENT,
          {
            from: this.origin,
            kind: notice.code.startsWith('structure.') ? 'structural-diagnosis' : 'coverage-gap',
            code: notice.code,
            severity: notice.severity,
            message: notice.message,
            ...(notice.hint !== undefined ? { hint: notice.hint } : {}),
            plugins: notice.plugins,
            evidence: notice.evidence,
            targets: notice.targets,
          },
        );
        notifiedPlugins += 1;
      } catch {
        // 事件派发失败不影响主流程：至少 agent 侧还看得到
      }
    }

    return { notifiedPlugins, forUser: notices };
  }
}

/**
 * 把结构诊断整形成 agent 可读的形状。
 *
 * @param outcome 通报结果。
 * @param grouped 原始聚合（仅用于给出"共几类警告"的规模感）。
 * @returns 结构化通报。
 */
export function shapeForAgent(
  outcome: NotifyOutcome,
  grouped: ProbeOutcome['grouped'],
): {
  structural_count: number;
  coverage_gap_count: number;
  raw_finding_count: number;
  notified_plugins: number;
  items: readonly StructuralNotice[];
  summary: string;
  note: string;
} {
  const structural = outcome.forUser.filter((item) => item.code.startsWith('structure.'));
  const coverage = outcome.forUser.filter((item) => item.code.startsWith('coverage.'));

  const parts: string[] = [];
  if (structural.length > 0) parts.push(`${structural.length} 条结构诊断`);
  if (coverage.length > 0) parts.push(`${coverage.length} 条覆盖缺口`);
  if (parts.length === 0) parts.push('无结构性问题');

  return {
    structural_count: structural.length,
    coverage_gap_count: coverage.length,
    // 原始警告数只作为规模参考 —— 它们**不在** items 里，
    // 因为那是对方自查的产物，不是 CLIS 的发现。
    raw_finding_count: grouped.reduce((sum, item) => sum + item.count, 0),
    notified_plugins: outcome.notifiedPlugins,
    items: outcome.forUser,
    summary: parts.join('；'),
    note:
      'items 里只有结构性判断。对方自查出的逐条问题不在此列出——' +
      '那些在各自插件的面板里已有显示，重复搬运只会造成噪音。',
  };
}

/** 把结构诊断转成去重机制要的 disposition 形状。 */
export function toDispositioned(
  notice: StructuralNotice,
  disposition: DispositionedFinding['disposition'],
  roundsUnresolved = 1,
): DispositionedFinding {
  return {
    code: notice.code,
    severity: notice.severity,
    message: notice.message,
    plugins: notice.plugins,
    count: notice.evidence.length,
    disposition,
    roundsUnresolved,
    alreadyEscalated: false,
  };
}
