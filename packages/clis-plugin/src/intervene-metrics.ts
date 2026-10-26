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
}

/** 一段汇总窗口的采用情况。 */
export interface InterventionSummary {
  readonly hinted: number;
  readonly adopted: number;
  /** 采用率 adopted/hinted（0–1）；hinted=0 时为 null（尚无样本）。 */
  readonly adoptionRate: number | null;
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
 * 读窗口内的记录并汇总。
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
  try {
    const raw = await readFile(path, 'utf8');
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    let scanned = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (++scanned > 10_000) break;
      try {
        const e = JSON.parse(s) as { t?: unknown; kind?: unknown };
        const t = Date.parse(String(e.t));
        if (!Number.isFinite(t) || t < cutoff) continue;
        if (e.kind === 'hinted') hinted += 1;
        else if (e.kind === 'adopted') adopted += 1;
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
    windowDays,
  };
}