/**
 * 回归：CLIS 只投递**结构诊断**，不转发对方自查的逐条问题。
 *
 * 用户指出（2026-10-26）：「clis探测的应该是除了记忆管理自己体验出的问题之外
 * 的问题，不然就重复了」。
 *
 * 早先实现把 memory-manager 的 memory_check 结果原样转发回它自己收件箱 ——
 * 而那些警告在它面板「总览」里已经显示。一个警告出现两次，收件箱零增量。
 *
 * 正确分工：
 * - 对方自查 → 逐条清单（它自己的面板已有）
 * - CLIS     → 这些问题的结构（跨问题判断，对方给不了）
 *
 * 本用例钉住：
 * 1. deriveNotices 只产出 structure.* / coverage.* 两种 code，
 *    绝不产出 `memory.R14` 这类对方自查的代号；
 * 2. 结构诊断的 message 说的是**关系**，不是复述单条警告；
 * 3. 覆盖缺口（无探针插件）和探针故障要单独报出来。
 */
import { describe, expect, it } from 'vitest';

import {
  deriveNotices,
  HEALTH_FINDING_EVENT,
  HealthNotifier,
  shapeForAgent,
} from '../packages/clis-plugin/src/health-notifier';
import type { ProbeOutcome } from '../packages/clis-plugin/src/health-supervisor';

/** 造一个体检结果。 */
function outcome(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    reports: [],
    grouped: [],
    status: 'ok',
    probeErrors: [],
    ...overrides,
  };
}

/** 造分组。 */
function grouped(code: string, count = 1, plugins = ['dsh-memory-manager']) {
  return {
    code,
    severity: 'warn' as const,
    count,
    plugins,
    message: `${code} 有问题`,
    hints: [] as string[],
  };
}

/** 循环因果的分析结果。 */
const CYCLIC = {
  causalType: 'cyclic',
  confidence: 0.9,
  questions: {
    q1_simultaneous_mutual_definition: 'no' as const,
    q2_delayed_mutual_influence: 'yes' as const,
    q3_strict_irreversible_order: 'no' as const,
    q4_coexisting_causal_structures: 'no' as const,
  },
  summary: '这 2 类问题反复出现，说明存在反馈环',
  direction: '找共同的产生环节',
};

/** 记录被 emit 的事件。 */
function recorder() {
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    emit: (name: string, payload: Record<string, unknown>) => emitted.push({ name, payload }),
  } as never;
  return { ctx, emitted };
}

describe('核心：不转发对方自查的逐条问题', () => {
  it('对方自查的 code（memory.R14）不出现在投递项里', () => {
    const notices = deriveNotices(
      outcome({
        grouped: [grouped('memory.R14', 2), grouped('memory.R3', 2)],
        analysis: CYCLIC,
      }),
      [],
    );

    // 关键断言：没有任何一条是 memory.* 这种对方自查代号
    expect(notices.every((item) => !item.code.startsWith('memory.'))).toBe(true);
    // 只有一条结构诊断
    expect(notices).toHaveLength(1);
    expect(notices[0]?.code).toBe('structure.cyclic');
  });

  it('原始警告只作为 evidence，不作为独立条目', () => {
    const notices = deriveNotices(
      outcome({
        grouped: [grouped('memory.R14', 2), grouped('memory.R3', 2)],
        analysis: CYCLIC,
      }),
      [],
    );

    expect(notices[0]?.evidence).toEqual([
      'memory.R14 ×2（dsh-memory-manager）',
      'memory.R3 ×2（dsh-memory-manager）',
    ]);
  });

  it('单条问题不值得说结构（避免过度解读）', () => {
    const notices = deriveNotices(
      outcome({
        grouped: [grouped('memory.R14', 1)],
        analysis: { ...CYCLIC, causalType: 'unidirectional', summary: '单点问题' },
      }),
      [],
    );

    // 一条问题直接修就行，说"结构"是过度解读
    expect(notices).toHaveLength(0);
  });
});

describe('覆盖缺口：CLIS 独有视角', () => {
  it('没有探针的插件要被报出来（用户在盲区里却不自知）', () => {
    const notices = deriveNotices(outcome(), ['dsh-session-tools', 'dsh-learning-mode']);

    const gap = notices.find((item) => item.code === 'coverage.no-probe');
    expect(gap).toBeDefined();
    expect(gap?.message).toContain('2 个活动插件');
    expect(gap?.plugins).toEqual(['dsh-session-tools', 'dsh-learning-mode']);
    expect(gap?.hint).toContain('监督盲区');
  });

  it('探针自身故障优先于业务问题（观测坏了会盖住病灶）', () => {
    const notices = deriveNotices(
      outcome({
        grouped: [grouped('memory.R14', 2)],
        probeErrors: [{ plugin: 'dsh-x', error: '探针崩了' }],
      }),
      [],
    );

    const broken = notices.find((item) => item.code === 'structure.probe-broken');
    expect(broken?.severity).toBe('error');
    expect(broken?.hint).toContain('先修探针');
  });
});

describe('事件投递', () => {
  it('结构诊断发给他方插件', () => {
    const { ctx, emitted } = recorder();
    const notifier = new HealthNotifier(ctx);
    const notices = deriveNotices(outcome(), ['dsh-x']);

    const result = notifier.notify(notices);

    expect(result.notifiedPlugins).toBe(1);
    expect(emitted[0]?.name).toBe(HEALTH_FINDING_EVENT);
  });

  it('载荷标明这是结构诊断而非问题清单', () => {
    const { ctx, emitted } = recorder();
    new HealthNotifier(ctx).notify([
      {
        code: 'structure.cyclic',
        severity: 'warn',
        message: '存在反馈环',
        plugins: ['dsh-memory-manager'],
        evidence: ['memory.R14 ×2'],
        targets: ['dsh-memory-manager'],
      },
    ]);

    const payload = emitted[0]?.payload;
    expect(payload?.['kind']).toBe('structural-diagnosis');
    expect(payload?.['from']).toBe('dsh-clis');
    expect(payload?.['evidence']).toEqual(['memory.R14 ×2']);
  });

  it('覆盖缺口的 kind 不同（语义要分清）', () => {
    const { ctx, emitted } = recorder();
    new HealthNotifier(ctx).notify([
      {
        code: 'coverage.no-probe',
        severity: 'warn',
        message: '有插件没探针',
        plugins: ['dsh-x'],
        evidence: [],
        targets: ['dsh-x'],
      },
    ]);

    expect(emitted[0]?.payload['kind']).toBe('coverage-gap');
  });

  it('emit 抛错不影响主流程', () => {
    const ctx = {
      emit: () => {
        throw new Error('事件系统坏了');
      },
    } as never;
    const notifier = new HealthNotifier(ctx);

    const result = notifier.notify(deriveNotices(outcome(), ['dsh-x']));
    expect(result.forUser).toHaveLength(1);
  });
});

describe('agent 可读形状', () => {
  it('摘要区分结构诊断与覆盖缺口', () => {
    const { ctx } = recorder();
    const notices = deriveNotices(outcome(), ['dsh-x', 'dsh-y']);
    const shaped = shapeForAgent(new HealthNotifier(ctx).notify(notices), []);

    expect(shaped.coverage_gap_count).toBe(1);
    expect(shaped.summary).toContain('覆盖缺口');
  });

  it('明确声明不列对方自查项（避免使用者误以为漏了）', () => {
    const { ctx } = recorder();
    const shaped = shapeForAgent(new HealthNotifier(ctx).notify(deriveNotices(outcome(), [])), []);

    expect(shaped.note).toContain('不在此列出');
    expect(shaped.note).toContain('重复搬运');
  });

  it('无问题时摘要说"无结构性问题"', () => {
    const { ctx } = recorder();
    const shaped = shapeForAgent(new HealthNotifier(ctx).notify([]), []);

    expect(shaped.summary).toBe('无结构性问题');
    expect(shaped.items).toHaveLength(0);
  });
});
