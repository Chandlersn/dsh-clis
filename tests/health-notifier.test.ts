/**
 * 回归：双向通报的**投递行为**。
 *
 * 用户要求：通报 agent 宿主，也要告诉对方插件。
 * 对方修了就不管；没修/没搞定 → 宿主介入并通报用户。
 *
 * 本用例钉住投递规则：
 * - new       → 发对方 + 提示 agent
 * - unresolved → 只发对方（不打扰用户，给修复时间）
 * - escalate  → 发对方 + **必须通报用户**
 * - resolved  → 不通报，只记一笔
 */
import { describe, expect, it } from 'vitest';

import type { DispositionedFinding } from '../packages/clis-plugin/src/health-seen';
import {
  HEALTH_FINDING_EVENT,
  HealthNotifier,
  shapeForAgent,
} from '../packages/clis-plugin/src/health-notifier';

/** 记录被 emit 的事件。 */
function recorder() {
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const ctx = {
    emit: (name: string, payload: unknown) => {
      emitted.push({ name, payload });
    },
  } as never;
  return { ctx, emitted };
}

/** 造一条处置项。 */
function item(
  code: string,
  disposition: DispositionedFinding['disposition'],
  rounds = 1,
): DispositionedFinding {
  return {
    code,
    severity: 'warn',
    message: `${code} 有问题`,
    plugins: ['dsh-memory-manager'],
    count: 1,
    disposition,
    roundsUnresolved: rounds,
    alreadyEscalated: false,
  };
}

describe('事件投递', () => {
  it('new / unresolved / escalate 都发给对方插件', () => {
    const { ctx, emitted } = recorder();
    const notifier = new HealthNotifier(ctx);

    const outcome = notifier.notify([
      item('A', 'new'),
      item('B', 'unresolved', 2),
      item('C', 'escalate', 3),
    ]);

    expect(outcome.notifiedPlugins).toBe(3);
    expect(emitted).toHaveLength(3);
    expect(emitted.every((entry) => entry.name === HEALTH_FINDING_EVENT)).toBe(true);
  });

  it('resolved 不发事件（问题已消失，没必要打扰对方）', () => {
    const { ctx, emitted } = recorder();
    const notifier = new HealthNotifier(ctx);

    const outcome = notifier.notify([item('A', 'resolved')]);

    expect(outcome.notifiedPlugins).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(outcome.resolved).toHaveLength(1);
  });

  it('事件载荷含 code / severity / rounds，便于对方判断紧急度', () => {
    const { ctx, emitted } = recorder();
    const notifier = new HealthNotifier(ctx);

    notifier.notify([item('R14', 'new')], new Map([['R14', '压成结论句']]));

    const payload = emitted[0]?.payload as Record<string, unknown>;
    expect(payload['from']).toBe('dsh-clis');
    expect(payload['code']).toBe('R14');
    expect(payload['severity']).toBe('warn');
    expect(payload['roundsUnresolved']).toBe(1);
    expect(payload['hint']).toBe('压成结论句');
  });

  it('emit 抛错时不影响主流程', () => {
    const ctx = {
      emit: () => {
        throw new Error('事件系统坏了');
      },
    } as never;
    const notifier = new HealthNotifier(ctx);

    // 不应抛错
    const outcome = notifier.notify([item('A', 'new')]);
    expect(outcome.forUser).toHaveLength(1);
  });
});

describe('用户通报范围（避免噪音）', () => {
  it('new 与 escalate 通报用户，unresolved 不通报', () => {
    const { ctx } = recorder();
    const notifier = new HealthNotifier(ctx);

    const outcome = notifier.notify([
      item('new-one', 'new'),
      item('still-broken', 'unresolved', 2),
      item('ignored-too-long', 'escalate', 3),
    ]);

    const codes = outcome.forUser.map((entry) => entry.code);
    expect(codes).toContain('new-one');
    expect(codes).toContain('ignored-too-long');
    expect(codes).not.toContain('still-broken');
  });
});

describe('agent 可读的通报形状', () => {
  it('区分 fix_now 与 needs_you', () => {
    const { ctx } = recorder();
    const notifier = new HealthNotifier(ctx);
    const outcome = notifier.notify([item('A', 'new'), item('B', 'escalate', 3)]);

    const shaped = shapeForAgent(outcome, 2);

    expect(shaped.items.find((entry) => entry.code === 'A')?.action).toBe('fix_now');
    expect(shaped.items.find((entry) => entry.code === 'B')?.action).toBe('needs_you');
    expect(shaped.new_count).toBe(1);
    expect(shaped.escalated_count).toBe(1);
  });

  it('摘要说明"对方未处理需你介入"', () => {
    const { ctx } = recorder();
    const notifier = new HealthNotifier(ctx);
    const outcome = notifier.notify([item('B', 'escalate', 3)]);

    const shaped = shapeForAgent(outcome, 3);
    expect(shaped.summary).toContain('未修复');
    expect(shaped.summary).toContain('需你介入');
  });

  it('全部修好时摘要说明已修复', () => {
    const { ctx } = recorder();
    const notifier = new HealthNotifier(ctx);
    const outcome = notifier.notify([item('A', 'resolved')]);

    const shaped = shapeForAgent(outcome, 2);
    expect(shaped.summary).toContain('已修复');
    expect(shaped.items).toHaveLength(0);
  });
});
