import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 互查通报的**去重与追踪状态**。
 *
 * 为什么必须有（否则这个功能三天就会被关掉）：
 * 每次体检都会重新发现同样的老问题。如果每次都通报，用户会被同一批
 * 警告反复打扰，很快就学会无视它 —— 通报机制等于没做。
 *
 * 设计要点：
 * 1. **同一 finding 只通报一次**：记下已通报的 code 集合；
 * 2. **追踪对方有没有修**：下一轮体检时该 code 若消失 = 已修好，不再管；
 *    若仍在 = 对方没执行或没搞定 → 升级为"需宿主介入"并通报用户；
 * 3. **按"升级阈值"控制节奏**：默认连续 2 轮未修才升级，避免一次
 *    临时失败就惊动用户。
 */

/** 一条被通报过的 finding 的追踪状态。 */
export interface TrackedFinding {
  readonly code: string;
  /** 首次通报时间（ISO 8601）。 */
  readonly firstSeenAt: string;
  /** 最近一次仍看到它的时间。 */
  readonly lastSeenAt: string;
  /** 已连续观察几轮仍存在。 */
  readonly roundsUnresolved: number;
  /** 是否已通报给用户（避免重复升级）。 */
  readonly escalated: boolean;
}

/** 去重状态文件形状。 */
export interface HealthSeenState {
  readonly version: number;
  readonly findings: Record<string, TrackedFinding>;
}

/** 文件版本。 */
const SEEN_VERSION = 1;

/** 落盘相对路径。 */
const SEEN_REL_PATH = join('storages', 'clis-health-seen.json');

/**
 * 状态文件路径。
 *
 * @returns 绝对路径。
 */
export function seenFilePath(): string {
  const root = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, SEEN_REL_PATH);
}

/**
 * 读取去重状态。
 *
 * @returns 状态；文件不存在或损坏时返回空状态。
 */
export async function readSeenState(): Promise<HealthSeenState> {
  try {
    const raw = await readFile(seenFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as HealthSeenState).version === SEEN_VERSION &&
      typeof (parsed as HealthSeenState).findings === 'object'
    ) {
      return parsed as HealthSeenState;
    }
  } catch {
    // 文件缺失或损坏都从空状态开始 —— 通报状态丢了最多多报一次，不会丢数据
  }
  return { version: SEEN_VERSION, findings: {} };
}

/**
 * 写入去重状态（原子替换）。
 *
 * @param state 新状态。
 */
export async function writeSeenState(state: HealthSeenState): Promise<void> {
  const path = seenFilePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, path);
  } catch {
    // 写不了就算了：多报一次比报错好
  }
}

/** 一次体检对某个 finding 的处置结论。 */
export type FindingDisposition =
  /** 首次出现：需要通报（对方 + agent）。 */
  | 'new'
  /** 此前通报过，这次仍存在：对方没修好。 */
  | 'unresolved'
  /** 连续多轮未修：升级，通报用户。 */
  | 'escalate'
  /** 通报过，这次消失了：已修复，从状态里移除。 */
  | 'resolved';

/** 一条待处置的 finding。 */
export interface DispositionedFinding {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly plugins: readonly string[];
  readonly count: number;
  readonly disposition: FindingDisposition;
  /** 已连续几轮未解决（new 时为 1）。 */
  readonly roundsUnresolved: number;
  /** 此前是否已升级过（避免重复通报用户）。 */
  readonly alreadyEscalated: boolean;
}

/**
 * 对比本次 findings 与历史状态，给出每条 finding 的处置结论。
 *
 * 这是"对方有没有修"的**唯一判据**：下一轮体检时该 code 消失 = 修好了。
 * 不需要对方主动回报 —— 主动回报容易漏、容易假报，而"问题还在不在"
 * 是可观测的事实。
 *
 * @param groupedCodes 本次体检聚合后的 code 列表。
 * @param previous 上次的去重状态。
 * @param escalateAfter 连续几轮未解决才升级；缺省 2。
 * @param now 当前时间（便于测试注入）。
 * @returns 每条 finding 的处置 + 更新后的状态。
 */
export function reconcileFindings(
  groupedCodes: readonly {
    code: string;
    severity: string;
    message: string;
    plugins: readonly string[];
    count: number;
  }[],
  previous: HealthSeenState,
  escalateAfter = 2,
  now = new Date().toISOString(),
): { dispositions: DispositionedFinding[]; next: HealthSeenState } {
  const dispositions: DispositionedFinding[] = [];
  const nextFindings: Record<string, TrackedFinding> = {};

  const seenCodes = new Set<string>();

  for (const item of groupedCodes) {
    seenCodes.add(item.code);
    const prior = previous.findings[item.code];

    if (prior === undefined) {
      // 首次出现
      dispositions.push({
        ...item,
        disposition: 'new',
        roundsUnresolved: 1,
        alreadyEscalated: false,
      });
      nextFindings[item.code] = {
        code: item.code,
        firstSeenAt: now,
        lastSeenAt: now,
        roundsUnresolved: 1,
        escalated: false,
      };
      continue;
    }

    // 通报过、仍然存在 → 对方没修好
    const rounds = prior.roundsUnresolved + 1;
    const shouldEscalate = rounds >= escalateAfter && !prior.escalated;

    dispositions.push({
      ...item,
      disposition: shouldEscalate ? 'escalate' : 'unresolved',
      roundsUnresolved: rounds,
      alreadyEscalated: prior.escalated,
    });

    nextFindings[item.code] = {
      code: item.code,
      firstSeenAt: prior.firstSeenAt,
      lastSeenAt: now,
      roundsUnresolved: rounds,
      escalated: prior.escalated || shouldEscalate,
    };
  }

  // 此前通报过、这次不见了 → 已修复，不再追踪
  for (const code of Object.keys(previous.findings)) {
    if (seenCodes.has(code)) continue;
    dispositions.push({
      code,
      severity: 'info',
      message: `此前的 ${code} 问题已消失`,
      plugins: [],
      count: 0,
      disposition: 'resolved',
      roundsUnresolved: 0,
      alreadyEscalated: previous.findings[code]?.escalated ?? false,
    });
  }

  return { dispositions, next: { version: SEEN_VERSION, findings: nextFindings } };
}
