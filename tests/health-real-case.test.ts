/**
 * 回归：真实体检场景 —— memory-manager 的 5 个 WARN 应被归并为"回路"。
 *
 * 这是互查机制第一次对真实数据生效的记录：
 * 5 条警告 → 聚合为 3 类（R14×2, R3×2, TEMP×1）→ 判定 cyclic。
 *
 * 关键教训：**四问翻译必须互斥**。首版把"同类反复"(q2) 与"多 code 同源"(q1)
 * 都填 yes，触发分类器 R3 结构冲突规则 → 误判为 nested（"需拆开处理"），
 * 而真相是两个 R14 和两个 R3 都是同类反复。改为优先级翻译后修正。
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import * as classifierPlugin from '@clis/clis-classifier';
import { HealthSupervisor } from '../packages/clis-plugin/src/health-supervisor';

/** memory_check 在 2026-10-26 报出的真实 5 条警告。 */
const REAL_FINDINGS = [
  { code: 'R14', severity: 'warn' as const, message: 'dsh插件开发.md 迭代块 934 字 > 900', hint: '压成结论句' },
  { code: 'R14', severity: 'warn' as const, message: '学习模式插件.md 迭代块 1165 字 > 900', hint: '压成结论句' },
  { code: 'R3', severity: 'warn' as const, message: 'workbuddy渠道接通.md 头部摘要过期', hint: '追加迭代须成对刷新' },
  { code: 'R3', severity: 'warn' as const, message: '宣传片制作.md 头部摘要过期', hint: '追加迭代须成对刷新' },
  { code: 'TEMP', severity: 'warn' as const, message: 'dsh-our-free-model渠道.md 冷记忆', hint: '确认是否活跃' },
];

/** 造一个真实探针来源。 */
function memoryManagerSource() {
  return {
    plugin: 'dsh-memory-manager',
    probe: async () => ({
      plugin: 'dsh-memory-manager',
      status: 'degraded' as const,
      findings: REAL_FINDINGS,
    }),
  };
}

describe('真实场景：memory-manager 的 5 个 WARN', () => {
  it('聚合为 3 类（同类合并）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const outcome = await new HealthSupervisor(ctx, [memoryManagerSource()]).run();

    expect(outcome.grouped).toHaveLength(3);
    expect(outcome.grouped.find((item) => item.code === 'R14')?.count).toBe(2);
    expect(outcome.grouped.find((item) => item.code === 'R3')?.count).toBe(2);
    expect(outcome.grouped.find((item) => item.code === 'TEMP')?.count).toBe(1);

    await ctx.fiber.dispose();
  });

  it('判定为回路（不是"需拆开处理"）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const outcome = await new HealthSupervisor(ctx, [memoryManagerSource()]).run();

    // 首版因四问不互斥而误判为 nested，此断言钉住修正后的行为
    expect(outcome.analysis?.causalType).toBe('cyclic');
    expect(outcome.analysis?.confidence).toBeGreaterThanOrEqual(0.7);

    await ctx.fiber.dispose();
  });

  it('四问作答互斥：只填 Q2', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const outcome = await new HealthSupervisor(ctx, [memoryManagerSource()]).run();
    const answers = outcome.analysis?.questions;

    expect(answers?.q2_delayed_mutual_influence).toBe('yes');
    // 同类反复已占用判定，不再同时给"互为定义"（否则触发 R3 冲突）
    expect(answers?.q1_simultaneous_mutual_definition).toBe('no');
    expect(answers?.q3_strict_irreversible_order).toBe('no');

    await ctx.fiber.dispose();
  });

  it('给出可操作的方向：找共同产生环节而非逐条修', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const outcome = await new HealthSupervisor(ctx, [memoryManagerSource()]).run();

    expect(outcome.analysis?.summary).toContain('反馈环');
    expect(outcome.analysis?.direction).toContain('共同的产生环节');

    await ctx.fiber.dispose();
  });
});