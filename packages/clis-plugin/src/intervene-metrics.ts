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
  /**
   * 事件种类。
   *
   * - `hinted`：注入了提示（症状出现了）
   * - `adopted`：提示后 agent 调了 CLIS 工具（听进去了）
   * - `skipped`：**看过这次失败、判定不介入**并记下原因（没出现的症状）
   *
   * ## 为什么必须有 skipped
   *
   * 只有 hinted/adopted 时，`adoptionRate` 是个**没有分母的比率**：
   * 它答不出"该提示而没提示的有多少"。于是"机制正常"与"根本没在管"
   * 在指标上完全同形 —— 实测过 hinted=0 持续两周无人察觉（监听器根本没
   * 注册），也实测过触发率 3.5% 被当作健康。两种情况数字不同、病因不同，
   * 但指标形态一样。
   *
   * 补上 skipped 之后，才第一次能算：
   *
   * - `evaluated = hinted + skipped` —— 机制真正看过多少失败
   * - `missRate = skipped / evaluated` —— 它自己承认放过了多少
   *
   * 这个数**不为 0 是正常的**（本就该大量放过）；但它必须**可读**，
   * 否则闸门等于在黑暗中调节。
   */
  readonly kind: 'hinted' | 'adopted' | 'skipped';
  /** agent 标识。 */
  readonly agent: string;
  /** 触发介入的工具名（hinted / skipped 时）。 */
  readonly tool?: string;
  /** 失败签名（hinted / skipped 时；与 intervene.ts 的去重键一致，便于关联）。 */
  readonly signature?: string;
  /**
   * skipped 的**原因代号**（skipped 时必有）。
   *
   * 每道闸门一个代号，且代号稳定 —— 它们会被按名字统计与检索，
   * 不能随文案改。设计见 `intervene.ts` 的 `SkipReason`。
   */
  readonly reason?: string;
  /** 该原因所属的闸门（skipped 时）—— 便于按"哪道闸门在多数否决"聚合。 */
  readonly gate?: string;
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
  /**
   * 机制**看过但主动放过**的失败次数（按 cause 分组的明细见 `skippedByReason`）。
   *
   * 这是 missing denominator：没有它，`adoptionRate` 只描述"提示被采纳多少"，
   * 不描述"该提示的有多少没被提示"。
   */
  readonly skipped: number;
  /** 按原因是细分的跳过计数（原因代号 → 次数），按次数降序便于直接看出主因。 */
  readonly skippedByReason: Record<string, number>;
  /** 按闸门细分的跳过计数（闸门代号 → 次数）。 */
  readonly skippedByGate: Record<string, number>;
  /**
   * 机制评估过的失败总数 = hinted + skipped。
   *
   * 它是"分母"的本体：`missRate` 才让"正常"与"根本没在管"可分。
   */
  readonly evaluated: number;
  /**
   * 漏判率 = skipped / evaluated（0–1）；evaluated=0 时为 null。
   *
   * 语义是"机制自己承认放过的比例"。**不为 0 是健康的** ——
   * 全放过（≈1）说明闸门形同虚设，全不放过（≈0）该查是不是在唠叨。
   */
  readonly missRate: number | null;
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
 * ## 一次提示最多兑现一次采纳（2026-10-30 修）
 *
 * 上一版只记"该 agent 最近一次提示的时间"，计数后**不清除**。于是一次提示
 * 会给它之后所有调用背书 —— 实测跑出 adopted=20 / hinted=9、采用率 2.22
 * 这种不可能的数值（分子大于分母）。
 *
 * 现在采纳成功后**消费掉**那次提示（从 `lastHintAt` 删除）：同一 agent 再来
 * 调用而没有新提示时，记为 `spontaneous`。这让"每次采纳都能追溯到某次具体
 * 提示"，采用率结构上不可能超过 1。
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
  let skipped = 0;
  const skippedByReason: Record<string, number> = {};
  const skippedByGate: Record<string, number> = {};
  /** agent → 该 agent 尚未被兑现的最近一次 hinted 时间戳。 */
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
        const e = JSON.parse(s) as {
          t?: unknown;
          kind?: unknown;
          agent?: unknown;
          reason?: unknown;
          gate?: unknown;
        };
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
            // 兑现：一次提示只能为一次采纳背书，否则分子会超过分母。
            lastHintAt.delete(agent);
          } else {
            spontaneous += 1;
          }
        } else if (e.kind === 'skipped') {
          // 漏判记录：既有原因也有闸门。缺字段的旧行按 unknown 计，
          // 不丢样本（丢样本会让分母偏小、missRate 虚低）。
          skipped += 1;
          const reason = typeof e.reason === 'string' && e.reason.length > 0 ? e.reason : 'unknown';
          const gate = typeof e.gate === 'string' && e.gate.length > 0 ? e.gate : 'unknown';
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
          skippedByGate[gate] = (skippedByGate[gate] ?? 0) + 1;
        }
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* 文件不存在 = 还没有任何介入 */
  }
  // 明细按次数降序：读的人第一眼要看到"哪道闸门否决得最多"。
  const byCountDesc = (o: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const evaluated = hinted + skipped;
  return {
    hinted,
    adopted,
    // 结构上 adopted ≤ hinted（每次采纳消费一次提示），但仍夹一次以防
    // 将来改动破坏这个不变量 —— 指标宁可保守，不可报出不可能的数值。
    adoptionRate: hinted === 0 ? null : Math.min(adopted / hinted, 1),
    spontaneous,
    skipped,
    skippedByReason: byCountDesc(skippedByReason),
    skippedByGate: byCountDesc(skippedByGate),
    evaluated,
    missRate: evaluated === 0 ? null : skipped / evaluated,
    windowDays,
  };
}

/** 重启后重建的抑制状态（与内存语义逐字一致）。 */
export interface HintedSeed {
  /** agent → 已提示过的签名集。 */
  readonly hinted: Map<string, Set<string>>;
  /** agent → 最近一次介入时间（冷却期起点）。 */
  readonly lastIntervened: Map<string, number>;
}

/**
 * 从既有 JSONL 重放出抑制状态 —— 让 `hinted` 去重跨重启存活。
 *
 * ## 为什么用重放而不是新存储（2026-11-02）
 *
 * 去重集此前是内存态：宿主一重启就清空，同一失败会**再提示一次**。
 * 真数据抓到过实例（重启后约 1 分钟，同 agent 同签名 pwsh:exit code # 误弹）。
 *
 * 解法不引入第二份账本：**事件流本来就在**（JSONL 是 append-only 事实源），
 * 重放它与内存语义逐字对齐：
 *
 * - `hinted` → 把该 (agent, signature) 加入去重集，并刷新该 agent 的冷却起点
 * - `adopted` → **整集清空**该 agent 的去重集（= markToolUsed 的语义：
 *   它真去用 CLIS 了，之后新失败按窗口重新判定）
 *
 * 新增一份持久化文件意味着两份真相可能分叉；重放让"事实源只有一个"。
 *
 * ## 判据边界
 *
 * 冷却起点取该 agent 最近一次 hinted 的**全史**时间（不受汇总窗口裁剪）——
 * 否则刚重启就撞的失败会把冷却当"没发生过"，连成一串提示。
 * 采纳的清空同样按全史顺序。坏行跳过（与 summarizeMetrics 一致）。
 *
 * @param dshHome 数据目录。
 * @returns 可直接灌进 InterveneState 的抑制集。
 */
export async function replayHintedState(dshHome: string): Promise<HintedSeed> {
  const path = metricsFilePath(dshHome);
  const hinted = new Map<string, Set<string>>();
  const lastIntervened = new Map<string, number>();
  try {
    const raw = await readFile(path, 'utf8');
    let scanned = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (++scanned > 10_000) break;
      try {
        const e = JSON.parse(s) as { t?: unknown; kind?: unknown; agent?: unknown; signature?: unknown };
        const t = Date.parse(String(e.t));
        if (!Number.isFinite(t)) continue;
        const agent = typeof e.agent === 'string' ? e.agent : '';
        if (agent.length === 0) continue;
        if (e.kind === 'hinted') {
          if (typeof e.signature === 'string' && e.signature.length > 0) {
            let set = hinted.get(agent);
            if (set === undefined) {
              set = new Set();
              hinted.set(agent, set);
            }
            set.add(e.signature);
            // 冷却起点：取较晚者（坏时钟防倒退，与 summarizeMetrics 同理由）
            const prior = lastIntervened.get(agent);
            if (prior === undefined || t > prior) lastIntervened.set(agent, t);
          }
        } else if (e.kind === 'adopted') {
          // markToolUsed 语义：真去用了 CLIS → 清空该 agent 的去重与冷却。
          hinted.delete(agent);
          lastIntervened.delete(agent);
        }
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* 文件不存在 = 没有历史，空种子（正常路径，不是错误） */
  }
  return { hinted, lastIntervened };
}