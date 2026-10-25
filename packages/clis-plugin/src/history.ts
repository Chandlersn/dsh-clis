import type { Context } from '@deepseek-ai/cordis';
import type { FeedbackSignalType, FourAnswers, KnownCausalType } from '@clis/clis-contracts';

/**
 * CLIS 的**结果回写**：把真实使用中的成败记下来，喂回反馈检测。
 *
 * 为什么必须有这一层：
 * 反馈服务是**无状态**的 —— 它靠调用方传入 `FeedbackHistory` 才能判定
 * "结果**反复**偏离"。而 `clis_run` 之前每次传空历史，外加执行器恒返回 ok，
 * 于是反馈永远判 effective，`type_misjudged` 这条最精巧的规则**从未被触发**。
 *
 * 这里不改四个组件的任何判据，只负责：
 * 1. 按"问题指纹"归档历史；
 * 2. 在下次调用同一问题时把历史读出来交给反馈。
 *
 * 存储用宿主 `storageDomain`（JSON domain），落盘位置由宿主决定；
 * 取不到时退化为进程内 Map，功能仍可用，只是不跨重启。
 */

/** 一条历史记录。 */
export interface ClisHistoryEntry {
  /** 该问题被判断为的因果类型。 */
  readonly causal_type: KnownCausalType | 'unknown';
  /** 反馈信号类型。 */
  readonly signal_type: FeedbackSignalType;
  /** 这次干预是否真的达成了目标（由 agent 如实回填）。 */
  readonly achieved: boolean;
  /** 一句话说明实际发生了什么。 */
  readonly detail: string;
  /** 记录时间（ISO 8601）。 */
  readonly at: string;
  /**
   * true 表示这条只是「尚未动手」的基线记录。
   *
   * 基线不计入失败次数 —— 否则第一次真实失败就会被误升级为
   * `type_misjudged`（契约里那要求「反复」偏离）。
   */
  readonly baseline?: boolean;
}

/** 某个问题的历史。 */
export interface ClisHistoryRecord {
  /** 问题指纹。 */
  readonly fingerprint: string;
  /** 问题原文（便于人读）。 */
  readonly description: string;
  /** 按时间顺序的记录。 */
  readonly entries: readonly ClisHistoryEntry[];
}

/** 归档上限：同一问题最多保留多少条，避免无限增长。 */
const MAX_ENTRIES_PER_FINGERPRINT = 20;

/**
 * 计算问题指纹（用于把同一条问题的多次尝试归到一起）。
 *
 * 用描述文本 + 四问作答做归一化后取哈希；不引入外部依赖，
 * 用 FNV-1a 32 位即可 —— 这里只需要稳定区分，不需要抗碰撞。
 *
 * @param description 问题描述。
 * @param answers 四问作答。
 * @returns 十六进制指纹。
 */
export function fingerprint(
  description: string,
  answers: FourAnswers,
): string {
  const material = [
    description.trim().toLowerCase().replace(/\s+/gu, ' '),
    answers.q1_simultaneous_mutual_definition,
    answers.q2_delayed_mutual_influence,
    answers.q3_strict_irreversible_order,
    answers.q4_coexisting_causal_structures,
  ].join('|');

  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 历史存储。
 *
 * 优先用宿主 `storageDomain` 落盘；不可用时退化到进程内 Map。
 */
export class ClisHistoryStore {
  /** 进程内兜底存储。 */
  private readonly memory = new Map<string, ClisHistoryRecord>();

  /** 宿主 domain 句柄（懒打开）。 */
  private domain: { get(key: string): unknown; set(key: string, value: unknown): void } | undefined;

  /** 是否已尝试打开 domain。 */
  private domainTried = false;

  /**
   * @param ctx 插件上下文（用于取 storageDomain）。
   */
  constructor(private readonly ctx: Context) {}

  /**
   * 打开宿主的 JSON domain。
   *
   * 取不到就静默退化到内存 —— 记忆不该因为存储不可用而让工具报错。
   */
  private async ensureDomain(): Promise<void> {
    if (this.domainTried) return;
    this.domainTried = true;

    const host = this.ctx as unknown as {
      storageDomain?: { open(spec: unknown): Promise<unknown> };
    };
    if (host.storageDomain === undefined) return;

    try {
      const domain = await host.storageDomain.open({
        name: 'clis-history',
        form: 'json',
      });
      if (
        domain !== null &&
        typeof domain === 'object' &&
        typeof (domain as { get?: unknown }).get === 'function' &&
        typeof (domain as { set?: unknown }).set === 'function'
      ) {
        this.domain = domain as {
          get(key: string): unknown;
          set(key: string, value: unknown): void;
        };
      }
    } catch {
      // 静默退化：内存存储仍可工作
    }
  }

  /**
   * 读某个问题的历史。
   *
   * @param key 问题指纹。
   * @returns 历史记录；无记录时返回空记录。
   */
  async read(key: string): Promise<ClisHistoryRecord | undefined> {
    await this.ensureDomain();
    if (this.domain !== undefined) {
      const stored = this.domain.get(key);
      if (stored !== undefined && stored !== null) return stored as ClisHistoryRecord;
    }
    return this.memory.get(key);
  }

  /**
   * 追加一条历史。
   *
   * @param key 问题指纹。
   * @param description 问题原文。
   * @param entry 这次的记录。
   */
  async append(key: string, description: string, entry: ClisHistoryEntry): Promise<void> {
    await this.ensureDomain();

    const existing = (await this.read(key)) ?? { fingerprint: key, description, entries: [] };
    const entries = [...existing.entries, entry].slice(-MAX_ENTRIES_PER_FINGERPRINT);
    const next: ClisHistoryRecord = { fingerprint: key, description, entries };

    this.memory.set(key, next);
    if (this.domain !== undefined) {
      this.domain.set(key, next);
    }
  }

  /**
   * 把历史整形成反馈服务要的 `previous_signals`。
   *
   * 只回传**同一类型假设**下的信号 —— 换了类型假设，旧信号不再构成
   * "同一假设下的反复偏离"，传给 feedback 会得出错误结论。
   *
   * @param record 历史记录。
   * @param assumedType 当前类型假设。
   * @returns 该假设下的历史信号（按时间顺序）。
   */
  static signalsFor(
    record: ClisHistoryRecord | undefined,
    assumedType: string,
  ): FeedbackSignalType[] {
    if (record === undefined) return [];
    return record.entries
      .filter((entry) => entry.causal_type === assumedType)
      .map((entry) => entry.signal_type);
  }

  /**
   * 同一类型假设下已回退过几次。
   *
   * @param record 历史记录。
   * @param assumedType 当前类型假设。
   * @returns 回退次数。
   */
  static rollbacksFor(record: ClisHistoryRecord | undefined, assumedType: string): number {
    if (record === undefined) return 0;
    return record.entries.filter(
      (entry) => entry.causal_type === assumedType && entry.signal_type === 'type_misjudged',
    ).length;
  }
}
