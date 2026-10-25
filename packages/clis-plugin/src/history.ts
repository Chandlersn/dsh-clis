import type { FeedbackSignalType, FourAnswers, KnownCausalType } from '@clis/clis-contracts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
 * 存储用宿主的数据目录直接落一个 JSON 文件（`<DSH_HOME>/storages/`，
 * 与宿主的 schedule.json / workspace.json 同区），**不碰宿主的 storageDomain**：
 * Cordis 的 Context 代理对未 inject 的服务键直接抛错
 * （实测 `cannot get property "storageDomain" without inject`），
 * 一个只做转发的工具层不该为此扩依赖，更不该让工具崩在存储上。
 * 文件不可读写时退化为进程内 Map —— 功能仍在，只是不跨重启。
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

/** 文件格式版本。 */
const HISTORY_FILE_VERSION = 1;

/** 落盘相对路径（宿主数据目录下）。 */
const HISTORY_REL_PATH = join('storages', 'clis-history.json');

/** 磁盘文件形状。 */
interface HistoryFileShape {
  readonly version: number;
  readonly records: Record<string, ClisHistoryRecord>;
}

/**
 * 历史文件路径。
 *
 * @returns 绝对路径。
 */
function historyFilePath(): string {
  const root = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, HISTORY_REL_PATH);
}

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
 * 历史存储：进程内 Map 为权威视图，写入串行刷盘。
 */
export class ClisHistoryStore {
  /** 权威内存视图。 */
  private readonly memory = new Map<string, ClisHistoryRecord>();

  /** 是否已从磁盘加载过。 */
  private loaded = false;

  /** 写入链：所有刷盘串行排队，避免并发 read-modify-write 丢更新。 */
  private chain: Promise<void> = Promise.resolve();

  /** 磁盘不可用时置真，此后只写内存。 */
  private diskDisabled = false;

  /**
   * 首次使用时从磁盘加载。
   *
   * 文件缺失 → 空视图；JSON 损坏 → **先把坏文件挪走备份**再从空视图开始，
   * 绝不静默覆盖（覆盖会让下一轮以为上一轮真的没发生过）。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    const path = historyFilePath();
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as HistoryFileShape).version === HISTORY_FILE_VERSION &&
        typeof (parsed as HistoryFileShape).records === 'object'
      ) {
        for (const [key, record] of Object.entries(
          (parsed as HistoryFileShape).records ?? {},
        )) {
          if (
            record !== null &&
            typeof record === 'object' &&
            Array.isArray(record.entries)
          ) {
            this.memory.set(key, record);
          }
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return; // 首次使用，正常
      // 读得到但解析不了：备份坏文件，从空开始，后续写入不再覆盖原件
      await this.quarantine(path);
    }
  }

  /**
   * 把损坏的历史文件挪成备份。
   *
   * @param path 原文件路径。
   */
  private async quarantine(path: string): Promise<void> {
    try {
      const backup = `${path}.corrupt-${Date.now()}`;
      await rename(path, backup);
    } catch {
      // 挪不动就算了：接下来的写入本就是尽力而为
    }
  }

  /**
   * 读某个问题的历史。
   *
   * @param key 问题指纹。
   * @returns 历史记录；无记录时返回 undefined。
   */
  async read(key: string): Promise<ClisHistoryRecord | undefined> {
    await this.ensureLoaded();
    return this.memory.get(key);
  }

  /**
   * 追加一条历史：先更新内存，再排队刷盘。
   *
   * @param key 问题指纹。
   * @param description 问题原文。
   * @param entry 这次的记录。
   */
  async append(key: string, description: string, entry: ClisHistoryEntry): Promise<void> {
    await this.ensureLoaded();

    const existing = this.memory.get(key);
    const entries = [...(existing?.entries ?? []), entry].slice(-MAX_ENTRIES_PER_FINGERPRINT);
    const next: ClisHistoryRecord = { fingerprint: key, description, entries };
    this.memory.set(key, next);

    this.chain = this.chain.then(() => this.flush());
    await this.chain;
  }

  /**
   * 全量刷盘（原子替换：写临时文件再 rename）。
   *
   * 任何失败都只关掉磁盘通道，不影响内存视图继续工作。
   */
  private async flush(): Promise<void> {
    if (this.diskDisabled) return;
    const path = historyFilePath();
    try {
      await mkdir(dirname(path), { recursive: true });
      const file: HistoryFileShape = {
        version: HISTORY_FILE_VERSION,
        records: Object.fromEntries(this.memory),
      };
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
      await rename(tmp, path);
    } catch {
      this.diskDisabled = true;
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
   * 数出**真实动手后**的失败次数。
   *
   * 基线记录（`baseline: true`，即"只做了判断没动手"）不算失败 ——
   * 否则第一次真实失败就会被误升级成 `type_misjudged`。
   *
   * @param record 历史记录。
   * @returns 真实失败次数。
   */
  static failures(record: ClisHistoryRecord | undefined): number {
    if (record === undefined) return 0;
    return record.entries.filter(
      (entry) =>
        entry.baseline !== true &&
        (entry.signal_type === 'ineffective' || entry.signal_type === 'type_misjudged'),
    ).length;
  }

  /**
   * 同一类型假设下已判过几次误判。
   *
   * @param record 历史记录。
   * @param assumedType 当前类型假设。
   * @returns 误判次数。
   */
  static rollbacksFor(record: ClisHistoryRecord | undefined, assumedType: string): number {
    if (record === undefined) return 0;
    return record.entries.filter(
      (entry) => entry.causal_type === assumedType && entry.signal_type === 'type_misjudged',
    ).length;
  }
}

