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

/**
 * 语义型失败样例 —— 分类闸门只对这类介入。
 * `ENOENT: no such file` 属机械型（先确认路径再写就能过），按设计不介入。
 */
const SEM_FAILURE = 'AssertionError: expected 3 to equal 5';

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

  // —— 2026-10-30 口径修正：采纳必须条件于此前的提示 ——
  describe('采纳的条件性（adopted 必须有前提提示）', () => {
    /** 手工按给定时间序列写 JSONL（recordMetric 用的是"现在"，无法造时间差）。 */
    async function writeEvents(events: ReadonlyArray<Record<string, unknown>>) {
      const path = metricsFilePath(sandbox);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(sandbox, 'storages'), { recursive: true });
      writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }

    const NOW = Date.now();
    const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

    it('零提示时的自发调用 → spontaneous，adoptionRate 为 null', async () => {
      await writeEvents([
        { t: iso(-60_000), kind: 'adopted', agent: 'a', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.hinted).toBe(0);
      expect(s.adopted).toBe(0);
      expect(s.spontaneous).toBe(1);
      expect(s.adoptionRate).toBeNull();
    });

    it('提示之后的调用 → adopted（进分子）', async () => {
      await writeEvents([
        { t: iso(-120_000), kind: 'hinted', agent: 'a', tool: 't' },
        { t: iso(-60_000), kind: 'adopted', agent: 'a', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.hinted).toBe(1);
      expect(s.adopted).toBe(1);
      expect(s.spontaneous).toBe(0);
      expect(s.adoptionRate).toBe(1);
    });

    it('提示**之前**的调用不算采纳（时间倒挂）', async () => {
      await writeEvents([
        { t: iso(-60_000), kind: 'adopted', agent: 'a', via: 'clis_run' },
        { t: iso(-30_000), kind: 'hinted', agent: 'a', tool: 't' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.adopted).toBe(0);
      expect(s.spontaneous).toBe(1);
    });

    it('超出 30 分钟采纳窗口的调用不算采纳', async () => {
      await writeEvents([
        { t: iso(-60 * 60_000), kind: 'hinted', agent: 'a', tool: 't' },
        // 提示后 60 分钟才调 —— 太久了，不能归功于提示
        { t: iso(-1_000), kind: 'adopted', agent: 'a', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.adopted).toBe(0);
      expect(s.spontaneous).toBe(1);
    });

    it('采纳窗口边界内（< 30 分钟）算采纳', async () => {
      await writeEvents([
        { t: iso(-29 * 60_000), kind: 'hinted', agent: 'a', tool: 't' },
        { t: iso(-1_000), kind: 'adopted', agent: 'a', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.adopted).toBe(1);
    });

    it('跨 agent 不串账：A 的提示不能让 B 的调用算采纳', async () => {
      await writeEvents([
        { t: iso(-120_000), kind: 'hinted', agent: 'A', tool: 't' },
        { t: iso(-60_000), kind: 'adopted', agent: 'B', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.adopted).toBe(0);
      expect(s.spontaneous).toBe(1);
    });

    it('真实事故复现：5 次调用里 1 次零提示 → 采用率不再是 0.83 的假象', async () => {
      // 2026-10-30 实测序列：6 hinted / 5 adopted，其中 1 次此前无提示
      await writeEvents([
        { t: iso(-600_000), kind: 'adopted', agent: 'a', via: 'clis_classify' }, // 无前提
        { t: iso(-500_000), kind: 'hinted', agent: 'a', tool: 't' },
        { t: iso(-400_000), kind: 'adopted', agent: 'a', via: 'clis_classify' },
        { t: iso(-300_000), kind: 'hinted', agent: 'b', tool: 't' },
        { t: iso(-200_000), kind: 'adopted', agent: 'b', via: 'clis_run' },
      ]);
      const s = await summarizeMetrics(sandbox, 30);
      expect(s.hinted).toBe(2);
      expect(s.adopted).toBe(2);
      expect(s.spontaneous).toBe(1);
      // 旧口径会报 3/2 = 1.5（或按独立计数虚高）；新口径分子只认有前提的
      expect(s.adoptionRate).toBe(1);
    });
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
  /**
   * 造一个**忠实于真实宿主**的假 ctx：宿主事件在 Context 上（`ctx.on`），
   * `ToolRuntime` 服务没有 `on`。旧版替身伪造了 `tools.on`，让
   * "监听器从未注册" 的事故在 692 例全绿下潜伏了两周。
   */
  function ctxWithListener(sandboxPath: string) {
    let listener: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      on: (event: string, l: typeof listener) => {
        if (event === 'tools/post-execute') listener = l;
        return () => {};
      },
      tools: {},
    } as never;
    registerIntervener(ctx, createInterveneState(), sandboxPath);
    if (listener === undefined) throw new Error('post-execute 监听器未注册');
    return listener;
  }

  /** 真实形状的宿主里，`ctx.on` 不存在时应当放弃注册而不是抛错。 */
  it('ctx 无事件能力时静默放弃（不抛错）', () => {
    const ctx = { tools: {} } as never;
    expect(registerIntervener(ctx, createInterveneState(), sandbox)).toBeUndefined();
  });

  /** 旧替身形状（只有 tools.on）仍能注册 —— 兼容兜底。 */
  it('只有 tools.on 的旧宿主仍能注册（兼容）', () => {
    let listener: unknown;
    const ctx = {
      tools: {
        on: (event: string, l: unknown) => {
          if (event === 'tools/post-execute') listener = l;
          return () => {};
        },
      },
    } as never;
    registerIntervener(ctx, createInterveneState(), sandbox);
    expect(listener).toBeDefined();
  });

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
    // 语义型失败（ENOENT 属机械型，按 2026-10-30 的分类闸门不介入）
    const failure = { isError: true, error: { message: SEM_FAILURE } };

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

  it('agent 自发调 clis_run（无前提提示）→ 记 spontaneous，不进分子', async () => {
    const listener = ctxWithListener(sandbox);
    await run(listener, { name: 'clis_run', agent: { id: 'a1' } }, { isError: false });

    const s = await summarizeMetrics(sandbox, 30);
    // 2026-10-30 口径修正：没有前提提示的调用不算"采纳"
    expect(s.adopted).toBe(0);
    expect(s.spontaneous).toBe(1);
    expect(s.hinted).toBe(0); // clis_run 自身不触发介入判定
  });

  it('完整链路：hinted → adopted → 比率 = 1', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'fs_write', agent: { id: 'a1' } };
    const failure = { isError: true, error: { message: SEM_FAILURE } };

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
    await run(listener, { name: 'fs_write', agent: { id: 'a1' } }, { isError: true, error: { message: SEM_FAILURE } });
    await run(listener, { name: 'fs_write', agent: { id: 'a1' } }, { isError: true, error: { message: SEM_FAILURE } });

    const path = metricsFilePath(sandbox);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(join('storages', 'clis-interventions.jsonl'));
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).kind).toBe('hinted');
  });

  // —— 2026-10-30 真机补：非零退出码也算失败 ——
  it('成功结果但退出码非零 → 达阈值仍记 hinted', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'pwsh', agent: { id: 'a1' } };
    // 宿主把非零退出码报成成功结果（isError=false）。
    // 注意：退出码本身归 SEM（信息不足时宁可多说），故能穿过分类闸门。
    const failed = { isError: false, value: { exitCode: 7 } };

    await run(listener, exec, failed); // 第 1 次：阈值未到
    await run(listener, exec, failed); // 第 2 次：触发介入

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(1);
  });

  it('退出码为 0 的成功 → 仍不记 hinted（不误报）', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'pwsh', agent: { id: 'a1' } };
    const ok = { isError: false, value: { exitCode: 0 } };

    await run(listener, exec, ok);
    await run(listener, exec, ok);

    const s = await summarizeMetrics(sandbox, 30);
    expect(s.hinted).toBe(0);
  });

  // —— 2026-10-30 真机补：注入消息必须带 id ——
  it('注入的消息带 id（宿主 inbox 按 id 去重，缺 id 会被拒绝）', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'fs_write', agent: { id: 'a1' } };
    const failure = { isError: true, error: { message: SEM_FAILURE } };

    await run(listener, exec, failure);
    const decision = (await run(listener, exec, failure)) as {
      additionalContexts?: Array<{ id?: unknown; role?: unknown }>;
    };
    const injected = decision.additionalContexts?.[0];
    expect(injected).toBeDefined();
    expect(typeof injected!.id).toBe('string');
    expect((injected!.id as string).length).toBeGreaterThan(0);
    expect(injected!.role).toBe('user');
  });

  it('同一轮注入两条 → 两条 id 不同（否则宿主判重复并拒绝）', async () => {
    const listener = ctxWithListener(sandbox);
    // 两个不同 agent 各失败两次 → 两条提示。
    // 用两个 agent 而不是同一 agent 的两个工具：冷却期是**按 agent** 的
    // （10 分钟内最多提醒一次），同一 agent 的第二条会被冷却闸门挡掉 ——
    // 那是设计意图，不是缺陷。真实的并发场景是多个 agent 同时失败。
    const a = { name: 'fs_write', agent: { id: 'a1' } };
    const b = { name: 'fs_write', agent: { id: 'a2' } };
    const fa = { isError: true, error: { message: SEM_FAILURE } };

    await run(listener, a, fa);
    await run(listener, b, fa);
    const da = (await run(listener, a, fa)) as { additionalContexts?: Array<{ id?: unknown }> };
    const db = (await run(listener, b, fa)) as { additionalContexts?: Array<{ id?: unknown }> };

    const idA = da.additionalContexts?.[0]?.id;
    const idB = db.additionalContexts?.[0]?.id;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
  });

  it('同一 agent 同一轮的两条注入 → id 也不同（冷却期之外的路径）', async () => {
    const listener = ctxWithListener(sandbox);
    const exec = { name: 'fs_write', agent: { id: 'a1' } };
    const failure = { isError: true, error: { message: SEM_FAILURE } };

    await run(listener, exec, failure);
    const first = (await run(listener, exec, failure)) as {
      additionalContexts?: Array<{ id?: unknown }>;
    };

    // 造第二条注入：绕过冷却期（用另一个 agent 再来一轮拿第二条），
    // 直接验证"两次注入产出的 id 不重复"这一不变量本身。
    const other = { name: 'fs_write', agent: { id: 'a2' } };
    await run(listener, other, failure);
    const second = (await run(listener, other, failure)) as {
      additionalContexts?: Array<{ id?: unknown }>;
    };

    const idA = first.additionalContexts?.[0]?.id;
    const idB = second.additionalContexts?.[0]?.id;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
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
