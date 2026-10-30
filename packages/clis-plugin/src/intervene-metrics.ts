import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 介入有效性的**可测指标** —— 回答"这套机制到底有没有人用"。
 *
 * ## 为什么需要它（2026-10-26 用户拍板"做啊"）
 *
 * 介入机制做了，"它有没有用"还没有数据。唯一不需要对照实验就能收集的
 * 指标是两个计数：
 *
 * - `hinted`：介入器实际注入了多少次提示（症状出现了）
 * - `adopted`：提示之后 agent 真的调用了 clis_run / clis_classify（听进去了）
 *
 * 采用率 = adopted / hinted。它不能证明"归因更准"（那需要对照实验），
 * 但能证明**这条链路是活的**：提示被看见、被采纳。若是 0，说明提示
 * 要么没人看见、要么没人信 —— 无论哪种，机制就该改，而不是继续加功能。
 *
 * ## 为什么不记进 memory-manager 的使用信号
 *
 * 查证过：`appendUsage(root, { href, kind })` 的 href 语义是**记忆文件路径**，
 * kind 是 recall/read/correction/positive —— 都围绕"某份记忆被用了"。
 * 介入有效性是**机制自身的运行数据**，不是"某份记忆被用了"；硬塞进去
 * 会让分层建议（实验/专项/通用）建立在变形的数据上。
 *
 * 所以复用的是 memory-manager 的**模式**（JSONL 追加、坏行跳过、fire-and-forget），
 * 不复用它的存储。文件落在 CLIS 自己的数据目录旁，与 clis-history.json 同区。
 */

/** 记录文件相对路径（与 clis-history.json 同区）。 */
const METRICS_REL_PATH = join('storages', 'clis-interventions.jsonl');

/** 单条介入记录。 */
export interface InterventionMetric {
  /** 介入时间（ISO 8601）。 */
  readonly t: string;
  /** 事件种类：hinted = 注入了提示；adopted = 提示后 agent 调了 CLIS 工具。 */
  readonly kind: 'hinted' | 'adopted';
  /** agent 标识。 */
  readonly agent: string;
  /** 触发介入的工具名（hinted 时）。 */
  readonly tool?: string;
  /** 失败签名（hinted 时；与 intervene.ts 的去重键一致，便于关联）。 */
  readonly signature?: string;
  /** 被调用的 CLIS 工具名（adopted 时）。 */
  readonly via?: string;
  /**
   * 采纳时距最近一次 hinted 的毫秒数（adopted 时，且确实有前提提示）。
   *
   * 为什么记它：这是"这次调用是否由提示引发"的唯一凭据。
   * 没有这个字段，adopted 就只是"某 agent 调了 CLIS"，与提示无关。
   */
  readonly after_hint_ms?: number;
}

/** 一段汇总窗口的采用情况。 */
export interface InterventionSummary {
  readonly hinted: number;
  /** **有条件**的采纳数：此前的 hinted 之后、同一 agent 调了 CLIS 的次数。 */
  readonly adopted: number;
  /** 采用率 adopted/hinted（0–1）；hinted=0 时为 null（尚无样本）。 */
  readonly adoptionRate: number | null;
  /**
   * 与提示无关的 CLIS 调用次数（agent 自己想起来用的）。
   *
   * 单列而不是并进 adopted：它**不进分子**。一个 agent 在没有任何提示的情况下
   * 自发调用 CLIS，说明工具本身有用，但证明不了"提示被采纳"。
   * 混进分子会让采用率虚高（2026-10-30 实测：5 次 adopted 里 1 次此前零提示，
   * 报出 0.83 的健康假象）。
   */
  readonly spontaneous: number;
  /** 最近 N 天才有数据；0 表示还没有任何介入发生。 */
  readonly windowDays: number;
}

/** 记录文件路径。 */
export function metricsFilePath(dshHome?: string): string {
  const root = dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  return join(root, METRICS_REL_PATH);
}

/**
 * 记一条。**fire-and-forget**：失败静默 —— 指标是增强，绝不打断介入或工具链路。
 *
 * @param dshHome 数据目录（测试注入用）。
 * @param entry 事件内容。
 */
export async function recordMetric(dshHome: string, entry: Omit<InterventionMetric, 't'>): Promise<void> {
  const path = metricsFilePath(dshHome);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 指标绝不打断主流程 */
  }
}

/**
 * 采纳判定的**时间条件**：一次 CLIS 调用要归功于提示，必须发生在
 * 同一 agent 的某次 hinted 之后这么长的窗口内。
 *
 * 为什么是 30 分钟：提示的作用是"这一轮别原样重试"，agent 采纳后通常
 * 紧接着就调 CLIS；30 分钟足够覆盖一轮长任务，又不至于把两小时后
 * 碰巧的自主调用算成"被提示引发"。
 */
const ADOPTION_WINDOW_MS = 30 * 60_000;

/**
 * 读窗口内的记录并汇总。
 *
 * ## 采纳必须**有条件**（2026-10-30 真实数据修正）
 *
 * 旧版把 `adopted` 与 `hinted` 当两个独立计数器直接相除。实测数据：
 *
 * ```
 * 07:04:41  adopted clis_classify  ← 此前 hinted: 0
 * 07:13:57  adopted clis_classify  ← 此前 hinted: 1
 * ```
 *
 * 5 次 adopted 里 1 次此前零提示 —— 那只是"这个 agent 调了 CLIS"，
 * 不是"提示被采纳"。分母 6、分子 5 的巧合让采用率报出 0.83 的健康假象。
 *
 * 现在按**事件顺序**重放：一次 adopted 只有在同一 agent 此前 30 分钟内有
 * hinted 才进分子；没有前提的记为 `spontaneous`，单列但不进分子。
 *
 * 坏行跳过（照 memory-manager readUsage 的先例）；数量上限 10_000 行——
 * 正常使用远达不到，只为防病态文件拖垮读取。
 *
 * @param dshHome 数据目录。
 * @param windowDays 汇总窗口（天）。
 */
export async function summarizeMetrics(dshHome: string, windowDays = 30): Promise<InterventionSummary> {
  const path = metricsFilePath(dshHome);
  let hinted = 0;
  let adopted = 0;
  let spontaneous = 0;
  /** agent → 该 agent 最近一次 hinted 的时间戳（按事件顺序滚动）。 */
  const lastHintAt = new Map<string, number>();
  try {
    const raw = await readFile(path, 'utf8');
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    let scanned = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (++scanned > 10_000) break;
      try {
        const e = JSON.parse(s) as { t?: unknown; kind?: unknown; agent?: unknown };
        const t = Date.parse(String(e.t));
        if (!Number.isFinite(t) || t < cutoff) continue;
        const agent = typeof e.agent === 'string' ? e.agent : '';
        if (e.kind === 'hinted') {
          hinted += 1;
          // 文件按时间追加，但坏时钟可能让顺序错乱：取较晚者，
          // 免得一条时间戳倒退的记录把"最近提示"改早、误伤后续采纳判定。
          const prior = lastHintAt.get(agent);
          if (prior === undefined || t > prior) lastHintAt.set(agent, t);
        } else if (e.kind === 'adopted') {
          const hintAt = lastHintAt.get(agent);
          if (hintAt !== undefined && t >= hintAt && t - hintAt <= ADOPTION_WINDOW_MS) {
            adopted += 1;
          } else {
            spontaneous += 1;
          }
        }
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* 文件不存在 = 还没有任何介入 */
  }
  return {
    hinted,
    adopted,
    adoptionRate: hinted === 0 ? null : adopted / hinted,
    spontaneous,
    windowDays,
  };
}