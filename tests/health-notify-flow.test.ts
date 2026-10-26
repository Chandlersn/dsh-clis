/**
 * 回归：**三轮通报闭环**的端到端行为。
 *
 * 用户要求（2026-10-26）：通报 agent 宿主，也告诉对方插件；
 * 对方修了就不管，没修/没搞定 → 宿主介入并通报用户。
 *
 * 本用例用真实探针 + 真实去重状态跑完整三轮，钉住：
 * - 第 1 轮 new       → 通报对方 + 提示 agent 处理
 * - 第 2 轮 escalate  → 通报对方 + **必须通报用户**
 * - 第 3 轮 unresolved→ 只发对方（已升级过，不重复打扰）
 * - 问题消失 → resolved，不再发事件
 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as classifierPlugin from '@clis/clis-classifier';
import { HealthNotifier, shapeForAgent } from '../packages/clis-plugin/src/health-notifier';
import { readSeenState, reconcileFindings, writeSeenState } from '../packages/clis-plugin/src/health-seen';
import { HealthSupervisor } from '../packages/clis-plugin/src/health-supervisor';

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'clis-notify-'));
  process.env.DSH_HOME = sandbox;
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

/** 一个恒报 R14 的探针。 */
const BROKEN_PROBE = {
  plugin: 'dsh-memory-manager',
  probe: async () => ({
    plugin: 'dsh-memory-manager',
    status: 'degraded' as const,
    findings: [{ code: 'R14', severity: 'warn' as const, message: '迭代块超长' }],
  }),
};

/** 一个健康的探针（模拟对方修好了）。 */
const HEALED_PROBE = {
  plugin: 'dsh-memory-manager',
  probe: async () => ({
    plugin: 'dsh-memory-manager',
    status: 'ok' as const,
    findings: [],
  }),
};

/** 跑一轮体检 + 通报，返回可断言的结果。 */
async function round(
  ctx: Context,
  probe: typeof BROKEN_PROBE | typeof HEALED_PROBE,
  escalateAfter = 2,
) {
  const outcome = await new HealthSupervisor(ctx, [probe]).run();
  const previous = await readSeenState();
  const { dispositions, next } = reconcileFindings(outcome.grouped, previous, escalateAfter);
  await writeSeenState(next);

  const notifier = new HealthNotifier(ctx);
  const notified = notifier.notify(dispositions);
  const shaped = shapeForAgent(notified, escalateAfter);

  return { dispositions, notified, shaped };
}

describe('三轮通报闭环', () => {
  it('完整流程：new → escalate → unresolved → resolved', async () => {
    await writeSeenState({ version: 1, findings: {} });

    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    const emitted: Array<{ name: string; payload: unknown }> = [];
    Object.defineProperty(ctx, 'emit', {
      value: (name: string, payload: unknown) => emitted.push({ name, payload }),
      configurable: true,
      writable: true,
    });

    // —— 第 1 轮：首次发现 ——
    const first = await round(ctx, BROKEN_PROBE);
    expect(first.dispositions[0]?.disposition).toBe('new');
    expect(first.notified.notifiedPlugins).toBe(1);
    expect(first.shaped.items[0]?.action).toBe('fix_now');
    expect(first.shaped.summary).toContain('已通报对方');

    // —— 第 2 轮：对方没修，达阈值升级 ——
    const second = await round(ctx, BROKEN_PROBE, 2);
    expect(second.dispositions[0]?.disposition).toBe('escalate');
    expect(second.notified.notifiedPlugins).toBe(1);
    expect(second.shaped.items[0]?.action).toBe('needs_you');
    expect(second.shaped.summary).toContain('需你介入');

    // —— 第 3 轮：已升级过，不再重复打扰用户 ——
    const third = await round(ctx, BROKEN_PROBE, 2);
    expect(third.dispositions[0]?.disposition).toBe('unresolved');
    expect(third.notified.notifiedPlugins).toBe(1); // 仍发对方
    expect(third.shaped.items).toHaveLength(0); // 不打扰用户

    // —— 第 4 轮：对方修好了 ——
    const fourth = await round(ctx, HEALED_PROBE, 2);
    expect(fourth.dispositions[0]?.disposition).toBe('resolved');
    expect(fourth.notified.notifiedPlugins).toBe(0); // resolved 不发事件
    expect(fourth.shaped.summary).toContain('已修复');

    await ctx.fiber.dispose();
  });

  it('发给对方的事件载荷可被对方直接消费', async () => {
    await writeSeenState({ version: 1, findings: {} });

    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    Object.defineProperty(ctx, 'emit', {
      value: (name: string, payload: Record<string, unknown>) => emitted.push({ name, payload }),
      configurable: true,
      writable: true,
    });

    await round(ctx, BROKEN_PROBE);

    const event = emitted[0];
    expect(event?.name).toBe('clis/health-finding');
    expect(event?.payload['code']).toBe('R14');
    expect(event?.payload['from']).toBe('dsh-clis');
    expect(event?.payload['plugins']).toContain('dsh-memory-manager');

    await ctx.fiber.dispose();
  });
});