/**
 * 回归：**结果回写**让类型误判检测真正能触发。
 *
 * 背景：反馈服务无状态，靠调用方传 `FeedbackHistory` 才能判定"反复偏离"。
 * 若工具层每次传空历史，外加执行器恒返回 ok，则 `type_misjudged`
 * 这条规则永远不可能触发 —— 闭环失去反馈能力。
 *
 * 本用例钉住四条语义：
 * 1. 一次失败记 `ineffective`，**不**升级为 `type_misjudged`；
 * 2. 连续第二次失败才升级为 `type_misjudged`；
 * 3. 成功记 `effective`，且基线记录（未动手）不计入失败次数；
 * 4. 历史落盘且能被下一个实例读回（跨重启）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClisHistoryStore, fingerprint } from '../packages/clis-plugin/src/history';

/** 四问作答（单向因果）。 */
const ANSWERS = {
  q1_simultaneous_mutual_definition: 'no',
  q2_delayed_mutual_influence: 'no',
  q3_strict_irreversible_order: 'yes',
  q4_coexisting_causal_structures: 'no',
} as const;

let sandboxRoot: string;

beforeAll(() => {
  // 把落盘目录指到临时区：测试绝不写进真实的 ~/.dsh/storages
  sandboxRoot = mkdtempSync(join(tmpdir(), 'clis-history-test-'));
  process.env.DSH_HOME = sandboxRoot;
});

afterAll(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

describe('问题指纹', () => {
  it('同一描述 + 同一作答得到同一指纹', () => {
    expect(fingerprint('调价抑制需求', ANSWERS)).toBe(fingerprint('调价抑制需求', ANSWERS));
  });

  it('描述不同则指纹不同', () => {
    expect(fingerprint('调价抑制需求', ANSWERS)).not.toBe(fingerprint('涨价压库存', ANSWERS));
  });

  it('作答不同则指纹不同', () => {
    const other = { ...ANSWERS, q3_strict_irreversible_order: 'no' as const };
    expect(fingerprint('调价抑制需求', ANSWERS)).not.toBe(fingerprint('调价抑制需求', other));
  });

  it('空白与大小写归一化后视为同一问题', () => {
    expect(fingerprint('  Price  UP  ', ANSWERS)).toBe(fingerprint('price up', ANSWERS));
  });
});

describe('历史归档与信号升级', () => {
  it('首次读取返回 undefined', async () => {
    const store = new ClisHistoryStore();
    expect(await store.read('nonexistent-key-xyz')).toBeUndefined();
  });

  it('追加后可读回，按时间顺序累积', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();

    await store.append('k-order', '示例问题', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      baseline: true,
      detail: '尚未动手',
      at,
    });
    await store.append('k-order', '示例问题', {
      causal_type: 'unidirectional',
      signal_type: 'type_misjudged',
      achieved: false,
      detail: '第二次仍失败',
      at,
    });

    const record = await store.read('k-order');
    expect(record?.entries.length).toBe(2);
    expect(record?.entries[0]?.signal_type).toBe('ineffective');
    expect(record?.entries[1]?.signal_type).toBe('type_misjudged');
  });

  it('signalsFor 只回传**同一类型假设**下的信号', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();
    await store.append('k-same', 'p', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      detail: 'd',
      at,
    });
    await store.append('k-same', 'p', {
      causal_type: 'cyclic',
      signal_type: 'effective',
      achieved: true,
      detail: 'd',
      at,
    });

    const record = await store.read('k-same');
    // 换了假设，旧信号不再构成"同一假设下的反复偏离"
    expect(ClisHistoryStore.signalsFor(record, 'cyclic')).toEqual(['effective']);
    expect(ClisHistoryStore.signalsFor(record, 'unidirectional')).toEqual(['ineffective']);
    expect(ClisHistoryStore.signalsFor(record, 'nested')).toEqual([]);
  });

  it('rollbacksFor 数出该假设下的误判次数', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();
    for (const signal of ['ineffective', 'type_misjudged', 'type_misjudged'] as const) {
      await store.append('k-rb', 'p', {
        causal_type: 'unidirectional',
        signal_type: signal,
        achieved: false,
        detail: 'd',
        at,
      });
    }
    const record = await store.read('k-rb');
    expect(ClisHistoryStore.rollbacksFor(record, 'unidirectional')).toBe(2);
  });

  it('单条问题的记录数有上限，最旧的被丢弃', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();
    for (let index = 0; index < 30; index += 1) {
      await store.append('k-cap', 'p', {
        causal_type: 'unidirectional',
        signal_type: 'ineffective',
        achieved: false,
        detail: `第 ${index} 次`,
        at,
      });
    }
    const record = await store.read('k-cap');
    expect(record?.entries.length).toBe(20);
    expect(record?.entries.at(-1)?.detail).toBe('第 29 次');
  });
});

describe('失败升级语义（契约要求「反复」）', () => {
  it('failures() 不把基线记录算作失败', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();

    await store.append('k-base', 'p', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      baseline: true,
      detail: '尚未动手',
      at,
    });

    const record = await store.read('k-base');
    expect(ClisHistoryStore.failures(record)).toBe(0);
  });

  it('第一次真实失败记 ineffective，第二次才升级 type_misjudged', async () => {
    const store = new ClisHistoryStore();
    const at = new Date().toISOString();

    await store.append('k-esc', 'p', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      baseline: true,
      detail: '尚未动手',
      at,
    });

    // 第一次真实失败：此前 failures()=0 → ineffective
    const beforeFirst = ClisHistoryStore.failures(await store.read('k-esc'));
    expect(beforeFirst).toBe(0);
    await store.append('k-esc', 'p', {
      causal_type: 'unidirectional',
      signal_type: beforeFirst > 0 ? 'type_misjudged' : 'ineffective',
      achieved: false,
      detail: '第一次失败',
      at,
    });
    expect((await store.read('k-esc'))?.entries.at(-1)?.signal_type).toBe('ineffective');

    // 第二次真实失败：此前 failures()=1 → type_misjudged
    const beforeSecond = ClisHistoryStore.failures(await store.read('k-esc'));
    expect(beforeSecond).toBe(1);
    await store.append('k-esc', 'p', {
      causal_type: 'unidirectional',
      signal_type: beforeSecond > 0 ? 'type_misjudged' : 'ineffective',
      achieved: false,
      detail: '第二次失败',
      at,
    });
    expect((await store.read('k-esc'))?.entries.at(-1)?.signal_type).toBe('type_misjudged');
  });
});

describe('持久化（跨实例，模拟重启）', () => {
  it('写入历史后，全新实例能从磁盘读回', async () => {
    const writer = new ClisHistoryStore();
    const at = new Date().toISOString();
    await writer.append('k-durable', '要跨重启保住的问题', {
      causal_type: 'cyclic',
      signal_type: 'effective',
      achieved: true,
      detail: '调价后需求稳定了',
      at,
    });

    // 新实例 = 宿主重启后的进程
    const reader = new ClisHistoryStore();
    const record = await reader.read('k-durable');
    expect(record).toBeDefined();
    expect(record?.description).toBe('要跨重启保住的问题');
    expect(record?.entries.at(-1)?.detail).toBe('调价后需求稳定了');
  });

  it('损坏的历史文件被挪走备份，从空开始而不是静默覆盖', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = join(sandboxRoot, 'storages', 'clis-history.json');

    // 制造一个解析不了的坏文件
    await writeFile(path, '{ this is not json', 'utf8');

    const store = new ClisHistoryStore();
    expect(await store.read('anything')).toBeUndefined();

    // 坏文件应被备份而非删除/覆盖
    const names = await import('node:fs/promises').then((fs) => fs.readdir(join(sandboxRoot, 'storages')));
    expect(names.some((name) => name.includes('corrupt'))).toBe(true);

    // 之后写入正常，能读到自己的记录
    await store.append('k-after', 'p', {
      causal_type: 'cyclic',
      signal_type: 'ineffective',
      achieved: false,
      detail: 'd',
      at: new Date().toISOString(),
    });
    expect(await store.read('k-after')).toBeDefined();
    // 确认还能被 JSON.parse（没被坏数据继续污染）
    JSON.parse(await readFile(path, 'utf8'));
  });
});
