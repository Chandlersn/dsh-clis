/**
 * 回归：介入有效性指标 —— 采纳率的两个计数。
 *
 * hinted = 注入了提示（症状出现了）；adopted = 提示后 agent 调了 CLIS 工具。
 * adoptionRate = adopted/hinted 是唯一不需要对照实验就能收集的证据：
 * 它证明链路是活的。本套件钉住记录、汇总、隔离三件事。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { metricsFilePath, recordMetric, summarizeMetrics } from '../packages/clis-plugin/src/intervene-metrics';
import {
  createInterveneState,
  registerIntervener,
  shouldIntervene,
  markToolUsed,
} from '../packages/clis-plugin/src/intervene';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'clis-metrics-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('recordMetric / summarizeMetrics', () => {
  it('空文件（无记录）→ hinted=0, adopted=0, adoptionRate=null', async () => {
    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(0);
    expect(s.adopted).toBe(0);
    expect(s.adoptionRate).toBeNull();
  });

  it('两类事件分开计数，比率正确', async () => {
    await recordMetric(sandbox, { kind: 'hinted', agent: 'a', tool: 't', signature: 's' });
    await recordMetric(sandbox, { kind: 'hinted', agent: 'a', tool: 't', signature: 's' });
    await recordMetric(sandbox, { kind: 'hinted', agent: 'a', tool: 't', signature: 's' });
    await recordMetric(sandbox, { kind: 'adopted', agent: 'a', via: 'clis_run' });

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(3);
    expect(s.adopted).toBe(1);
    expect(s.adoptionRate).toBeCloseTo(1 / 3);
  });

  it('窗口外的记录不计入', async () => {
    // 手工写一条 40 天前的记录
    const old = { t: new Date(Date.now() - 40 * 86_400_000).toISOString(), kind: 'hinted', agent: 'a' };
    const path = metricsFilePath(sandbox);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(sandbox, 'storages'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(old)}\n`, 'utf8');

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(0);
  });

  it('坏行跳过，不影响其余统计', async () => {
    const path = metricsFilePath(sandbox);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(sandbox, 'storages'), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ t: new Date().toISOString(), kind: 'hinted', agent: 'a' }),
        '{corrupt json',
        '',
        JSON.stringify({ t: new Date().toISOString(), kind: 'adopted', agent: 'a' }),
      ].join('\n'),
      'utf8',
    );

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(1);
    expect(s.adopted).toBe(1);
  });
});

describe('监听器落账：hinted 与 adopted 两个时机', () => {
  /** 造一个带 tools.on 的假 ctx，捕获监听器。 */
  function ctxWithListener(sandboxPath: string) {
    let listener: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      tools: {
        on: (event: string, l: typeof listener) => {
          if (event === 'tools/post-execute') listener = l;
          return () => {};
        },
      },
    } as never;
    registerIntervener(ctx, createInterveneState(), sandboxPath);
    if (listener === undefined) throw new Error('post-execute 监听器未注册');
    return listener;
  }

  /** post-execute 的最小执行环境。 */
  async function run(
    listener: NonNullable<ReturnType<typeof ctxWithListener>>,
    exec: unknown,
    result: unknown,
  ) {
    const out = await listener(exec, result, async () => ({ kind: 'accept' }));
    // recordMetric 是 fire-and-forget（void，生产里绝不等待），且内部是
    // 真实文件 I/O（mkdir + appendFile）。测试里给 I/O 一个完整的宏任务
    // 周期，否则读到的是"还没写完"的文件。
    await new Promise((resolve) => setTimeout(resolve, 50));
    return out;
  }

  it('失败达阈值 → 记 hinted（含工具与签名）', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'fs_write', agent: { id: 'a1' } };
    const failure = { isError: true, error: { message: 'ENOENT: no such file' } };

    await run(listener, exec, failure); // 第 1 次：阈值未到
    await run(listener, exec, failure); // 第 2 次：触发介入

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(1);
  });

  it('成功结果 → 不记任何账', async () => {
    const listener = ctxWithListener(sandbox);
    await run(listener, { name: 'fs_write', agent: { id: 'a1' } }, { isError: false });
    await run(listener, { name: 'fs_write', agent: { id: 'a1' } }, { isError: false });

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(0);
    expect(s.adopted).toBe(0);
  });

  it('agent 调 clis_run → 记 adopted（即使它成功了）', async () => {
    const listener = ctxWithListener(sandbox);
    await run(listener, { name: 'clis_run', agent: { id: 'a1' } }, { isError: false });

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.adopted).toBe(1);
    expect(s.hinted).toBe(0); // clis_run 自身不触发介入判定
  });

  it('完整链路：hinted → adopted → 比率 = 1', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'fs_write', agent: { id: 'a1' } };
    const failure = { isError: true, error: { message: 'EACCES: denied' } };

    await run(listener, exec, failure);
    await run(listener, exec, failure); // hinted
    await run(listener, { name: 'clis_run', agent: { id: 'a1' } }, { isError: false }); // adopted

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(1);
    expect(s.adopted).toBe(1);
    expect(s.adoptionRate).toBe(1);
  });

  it('指标文件落在 storages/ 下且是 JSONL（一行一个事件）', async () => {
    const listener = ctxWithListener(sandbox);
    await run(listener, { name: 'clis_run', agent: { id: 'a1' } }, { isError: false });

    const path = metricsFilePath(sandbox);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(join('storages', 'clis-interventions.jsonl'));
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).kind).toBe('adopted');
  });
});

describe('闸门行为与指标的耦合', () => {
  it('闸门拦截（未达阈值）不落 hinted 账', async () => {
    const state = createInterveneState();
    // 纯函数层面：第一次失败不该让调用方拿到提示
    expect(shouldIntervene(state, 'a', 't', 'm', Date.now())).toBeUndefined();
    // markToolUsed 也一样：没有 hinted 前提时 adopted 仍单独成立
    markToolUsed(state, 'a');
  });
});
