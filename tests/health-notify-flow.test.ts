/**
 * 回归：系统级监督的**完整流程** —— 枚举全系统插件 → 结构诊断 → 投递 → 去重追踪。
 *
 * 用户要求（2026-10-26）：
 * 1. CLIS 监督的是**整个插件列表**，不是某一个（为以后增加插件打基础）；
 * 2. 只投递对方自查报不出来的东西（结构诊断 + 覆盖缺口），
 *    不转发对方面板里已经显示的逐条警告。
 *
 * 本用例用真实 Context + 真实去重状态跑完整一轮，钉住：
 * - loader 枚举出的插件全部纳入监督范围；
 * - 没有探针的插件被记为覆盖缺口；
 * - 同一结构诊断第二轮不再当新问题；
 * - 结构码消失后算 resolved。
 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as classifierPlugin from '@clis/clis-classifier';
import { deriveNotices, HealthNotifier } from '../packages/clis-plugin/src/health-notifier';
import { readSeenState, reconcileFindings, writeSeenState } from '../packages/clis-plugin/src/health-seen';
import { HealthSupervisor } from '../packages/clis-plugin/src/health-supervisor';
import { buildScope, listPlugins } from '../packages/clis-plugin/src/plugin-scope';

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'clis-scope-'));
  process.env.DSH_HOME = sandbox;
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

/** 造一个假 loader（模拟宿主枚举）。 */
function loaderCtx(plugins: Array<{ id: string; state: number }>) {
  const entries = plugins.map((item) => ({
    options: { id: item.id },
    fiber: { state: item.state },
  }));
  return {
    loader: { entries: () => entries.values() },
  } as never;
}

/** 一个恒报问题的探针。 */
function brokenProbe(plugin: string, codes: string[]) {
  return {
    plugin,
    probe: async () => ({
      plugin,
      status: 'degraded' as const,
      findings: codes.map((code) => ({
        code,
        severity: 'warn' as const,
        message: `${code} 有问题`,
      })),
    }),
  };
}

describe('枚举整个插件列表（系统级监督的基础）', () => {
  it('loader 里的插件全部被发现', () => {
    const ctx = loaderCtx([
      { id: 'dsh-clis', state: 2 },
      { id: 'dsh-memory-manager', state: 2 },
      { id: 'dsh-session-tools', state: 2 },
    ]);

    const found = listPlugins(ctx);

    expect(found.map((item) => item.id)).toEqual([
      'dsh-clis',
      'dsh-memory-manager',
      'dsh-session-tools',
    ]);
  });

  it('未激活的插件不算在监督范围内', () => {
    const ctx = loaderCtx([
      { id: 'dsh-active', state: 2 },
      { id: 'dsh-inactive', state: 0 },
      { id: 'dsh-loading', state: 1 },
    ]);

    // v2 语义：uncovered 只列"活动的非内建插件里没探针的"
    const { externalTotal, uncovered } = buildScope(listPlugins(ctx), []);
    expect(externalTotal).toBe(1);
    expect(uncovered).toEqual(['dsh-active']);
  });

  it('宿主没有 loader 时安全降级为空（不崩）', () => {
    expect(listPlugins({} as never)).toEqual([]);
  });

  it('新增插件自动进入监督范围（无需改代码）', () => {
    const before = listPlugins(loaderCtx([{ id: 'a', state: 2 }]));
    const after = listPlugins(loaderCtx([{ id: 'a', state: 2 }, { id: 'brand-new-plugin', state: 2 }]));

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after.map((item) => item.id)).toContain('brand-new-plugin');
  });
});

describe('覆盖缺口：谁在盲区', () => {
  it('没有探针的活动插件被列为未覆盖', () => {
    const ctx = loaderCtx([
      { id: 'dsh-clis', state: 2 },
      { id: 'dsh-session-tools', state: 2 },
    ]);

    const { uncovered } = buildScope(listPlugins(ctx), [brokenProbe('dsh-clis', [])]);

    expect(uncovered).toContain('dsh-session-tools');
    expect(uncovered).not.toContain('dsh-clis');
  });

  it('全部插件都有探针时无缺口', () => {
    const ctx = loaderCtx([
      { id: 'a', state: 2 },
      { id: 'b', state: 2 },
    ]);

    const { uncovered } = buildScope(listPlugins(ctx), [brokenProbe('a', []), brokenProbe('b', [])]);
    expect(uncovered).toEqual([]);
  });
});

describe('完整流程：枚举 → 诊断 → 投递 → 追踪', () => {
  it('只投递结构诊断与覆盖缺口，不投递对方自查项', async () => {
    await writeSeenState({ version: 1, findings: {} });

    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    Object.defineProperty(ctx, 'emit', {
      value: () => {},
      configurable: true,
      writable: true,
    });

    // 对方自查报三条（两条同类）→ 应被判为回路，且只投递一条结构诊断
    const sources = [brokenProbe('dsh-memory-manager', ['memory.R14', 'memory.R14', 'memory.R3'])];
    const outcome = await new HealthSupervisor(ctx, sources).run();

    const notices = deriveNotices(outcome, ['dsh-session-tools']);

    // 1 条覆盖缺口 + 1 条结构诊断，没有 memory.* 条目
    expect(notices.every((item) => !item.code.startsWith('memory.'))).toBe(true);
    const codes = notices.map((item) => item.code).sort();
    expect(codes).toEqual(['coverage.no-probe', 'structure.cyclic']);

    await ctx.fiber.dispose();
  });

  it('同一诊断第二轮不重复当新问题（去重生效）', async () => {
    await writeSeenState({ version: 1, findings: {} });

    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    Object.defineProperty(ctx, 'emit', {
      value: () => {},
      configurable: true,
      writable: true,
    });

    const sources = [brokenProbe('p', ['x.1', 'x.1'])];
    const escalateAfter = 2;

    /** 跑一轮：诊断 → 去重 → 投递。 */
    async function round() {
      const outcome = await new HealthSupervisor(ctx, sources).run();
      const notices = deriveNotices(outcome, []);
      const previous = await readSeenState();
      const { dispositions, next } = reconcileFindings(
        notices.map((notice) => ({
          code: notice.code,
          severity: notice.severity,
          message: notice.message,
          plugins: notice.plugins,
          count: notice.evidence.length,
        })),
        previous,
        escalateAfter,
      );
      await writeSeenState(next);
      return dispositions;
    }

    const first = await round();
    expect(first[0]?.disposition).toBe('new');

    const second = await round();
    // 第二轮该码仍在 → 达阈值升级，而不是又当新问题
    expect(second[0]?.disposition).toBe('escalate');
    expect(second[0]?.roundsUnresolved).toBe(2);

    await ctx.fiber.dispose();
  });

  it('结构诊断消失后算 resolved', async () => {
    await writeSeenState({ version: 1, findings: {} });

    const first = reconcileFindings(
      [
        {
          code: 'structure.cyclic',
          severity: 'warn',
          message: '存在反馈环',
          plugins: ['p'],
          count: 2,
        },
      ],
      { version: 1, findings: {} },
      2,
    );
    await writeSeenState(first.next);

    const previous = await readSeenState();
    const second = reconcileFindings([], previous, 2);

    const resolved = second.dispositions.find((item) => item.code === 'structure.cyclic');
    expect(resolved?.disposition).toBe('resolved');
  });
});

describe('投递器与新形状接线', () => {
  it('结构诊断发给涉及的插件，同时进 forUser', () => {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = {
      emit: (_name: string, payload: Record<string, unknown>) => emitted.push(payload),
    } as never;

    const notifier = new HealthNotifier(ctx);
    const result = notifier.notify([
      {
        code: 'structure.cyclic',
        severity: 'warn',
        message: '存在反馈环',
        plugins: ['dsh-memory-manager'],
        evidence: ['memory.R14 ×2'],
        targets: ['dsh-memory-manager'],
      },
    ]);

    expect(result.notifiedPlugins).toBe(1);
    expect(result.forUser).toHaveLength(1);
    expect(emitted[0]?.['targets']).toEqual(['dsh-memory-manager']);
  });
});
