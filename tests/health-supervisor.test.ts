/**
 * 回归：跨插件互查的**核心翻译环节** —— 把聚合后的体检发现翻译成四问作答。
 *
 * 这是整个互查机制的关键：五条 WARN 逐条看是五个问题，但如果它们
 * 是同一个环的切面，逐条修都会失败。翻译对不对，决定了结论对不对。
 *
 * 本用例钉住四条映射规则：
 * - 同类问题反复出现（count>1） ⇒ Q2=yes（回路）
 * - 多个 code 落在同一插件/位置 ⇒ Q1=yes（互为定义）
 * - 单一问题且无探针故障      ⇒ Q3=yes（单向）
 * - 既有探针故障又有业务问题   ⇒ Q4=yes（需拆开）
 */
import { describe, expect, it } from 'vitest';

import type { HealthReport } from '@clis/clis-contracts';
import { deriveStatus } from '@clis/clis-contracts';
import { HealthSupervisor, groupFindings } from '../packages/clis-plugin/src/health-supervisor';

/** 造一个探针报告。 */
function report(
  plugin: string,
  findings: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message?: string; hint?: string }>,
): HealthReport {
  const full = findings.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: item.message ?? `${item.code} 问题`,
    ...(item.hint !== undefined ? { hint: item.hint } : {}),
  }));
  return { plugin, status: deriveStatus(full), findings: full };
}

/** 造一个能记录四问作答的假分类器。 */
function fakeCtx(captured: { answers?: Record<string, string> }) {
  // 与真实 Cordis 一致：通过 ctx.get() 取服务（supervisor 已改用 get）
  const classifier = {
      classify: async (problem: { answers: Record<string, string> }) => {
        captured.answers = problem.answers;
        // 简化：Q2=yes 判 cyclic，Q1=yes 判 duality，Q4=yes 判 nested，否则 unidirectional
        const a = problem.answers;
        const causal_type =
          a.q4_coexisting_causal_structures === 'yes'
            ? 'nested'
            : a.q2_delayed_mutual_influence === 'yes'
              ? 'cyclic'
              : a.q1_simultaneous_mutual_definition === 'yes'
                ? 'structural_duality'
                : 'unidirectional';
        return { causal_type, confidence: 0.9 };
      },
  };
  return {
    get: (name: string) => (name === 'clis.causalClassifier' ? classifier : undefined),
  } as never;
}

/** 造一个探针来源。 */
function source(plugin: string, findings: Parameters<typeof report>[1]) {
  return { plugin, probe: async () => report(plugin, findings) };
}

describe('findings 聚合', () => {
  it('同一 code 在多插件出现时合并计数', async () => {
    const sources = [
      source('plugin-a', [{ code: 'link-dangling', severity: 'warn' }]),
      source('plugin-b', [{ code: 'link-dangling', severity: 'warn' }]),
    ];
    const supervisor = new HealthSupervisor(fakeCtx({}), sources);
    const outcome = await supervisor.run();

    const grouped = outcome.grouped.find((item) => item.code === 'link-dangling');
    expect(grouped?.count).toBe(2);
    expect(grouped?.plugins).toEqual(['plugin-a', 'plugin-b']);
  });

  it('聚合后的严重度取最严重的那个', async () => {
    const sources = [
      source('p', [{ code: 'x', severity: 'info' }]),
      source('q', [{ code: 'x', severity: 'error' }]),
    ];
    const outcome = await new HealthSupervisor(fakeCtx({}), sources).run();
    expect(outcome.grouped[0]?.severity).toBe('error');
  });

  it('按严重程度排序：error 在前', () => {
    const reports = [
      report('a', [{ code: 'low', severity: 'info' }]),
      report('b', [{ code: 'high', severity: 'error' }]),
      report('c', [{ code: 'mid', severity: 'warn' }]),
    ];
    const grouped = groupFindings(reports);
    expect(grouped.map((item) => item.severity)).toEqual(['error', 'warn', 'info']);
  });
});

describe('四问自动翻译（互查的核心）', () => {
  it('同一 code 轮内重复 ⇒ 不判回路（真机 bug：曾据此误判反馈环）', async () => {
    const captured: { answers?: Record<string, string> } = {};
    // 同一 code 出现两次只是"同一规则在两处触发"，不是"修了又回来"
    const sources = [
      source('p', [{ code: 'R14', severity: 'warn' }, { code: 'R14', severity: 'warn' }]),
    ];

    const outcome = await new HealthSupervisor(fakeCtx(captured), sources).run();

    // 回路只能由跨轮数据判定 —— 轮内数据一律填 no
    expect(captured.answers?.q2_delayed_mutual_influence).toBe('no');
    expect(outcome.analysis?.causalType).not.toBe('cyclic');
    // 也不得声称"反馈环"
    expect(outcome.analysis?.summary).not.toContain('反馈环');
  });

  it('多个 code 落在同一插件 ⇒ 判为同源(duality)，措辞保守', async () => {
    const captured: { answers?: Record<string, string> } = {};
    const sources = [
      source('p', [
        { code: 'a', severity: 'warn' },
        { code: 'b', severity: 'warn' },
      ]),
    ];

    const outcome = await new HealthSupervisor(fakeCtx(captured), sources).run();

    expect(captured.answers?.q1_simultaneous_mutual_definition).toBe('yes');
    expect(outcome.analysis?.causalType).toBe('structural_duality');
    // 多类问题同属一个插件只是**弱证据**：给"先查同源性"，不给"两边一起改"的断言
    expect(outcome.analysis?.direction).toContain('同一个产生环节');
    expect(outcome.analysis?.summary).toContain('可能');
  });

  it('单一问题且无探针故障 ⇒ 判为单向(unidirectional)', async () => {
    const captured: { answers?: Record<string, string> } = {};
    const sources = [source('p', [{ code: 'only', severity: 'warn' }])];

    const outcome = await new HealthSupervisor(fakeCtx(captured), sources).run();

    expect(captured.answers?.q3_strict_irreversible_order).toBe('yes');
    expect(outcome.analysis?.causalType).toBe('unidirectional');
  });

  it('探针自身故障 + 业务问题 ⇒ 判为嵌套(nested)，优先修观测能力', async () => {
    const captured: { answers?: Record<string, string> } = {};
    const sources = [
      source('good', [{ code: 'a', severity: 'warn' }]),
      {
        plugin: 'broken',
        probe: async () => {
          throw new Error('探针自身崩了');
        },
      },
    ];

    const outcome = await new HealthSupervisor(fakeCtx(captured), sources).run();

    expect(captured.answers?.q4_coexisting_causal_structures).toBe('yes');
    expect(outcome.analysis?.causalType).toBe('nested');
    expect(outcome.analysis?.direction).toContain('先修探针');
    expect(outcome.probeErrors).toHaveLength(1);
    expect(outcome.probeErrors[0]?.plugin).toBe('broken');
  });
});

describe('探针故障不被静默吞掉', () => {
  it('探针抛错时整体状态为 failing', async () => {
    const sources = [
      {
        plugin: 'broken',
        probe: async () => {
          throw new Error('boom');
        },
      },
    ];
    const outcome = await new HealthSupervisor(fakeCtx({}), sources).run();

    expect(outcome.status).toBe('failing');
    expect(outcome.probeErrors[0]?.error).toContain('boom');
    // 探针崩了不该让汇总也崩
    expect(outcome.reports).toHaveLength(0);
  });
});

describe('无问题时不做无谓判断', () => {
  it('全部健康时不调用分类器', async () => {
    let called = false;
    const ctx = {
      'clis.causalClassifier': {
        classify: async () => {
          called = true;
          return { causal_type: 'unidirectional', confidence: 0.9 };
        },
      },
    } as never;

    const outcome = await new HealthSupervisor(ctx, [source('p', [])]).run();

    expect(called).toBe(false);
    expect(outcome.status).toBe('ok');
    expect(outcome.analysis).toBeUndefined();
  });
});

describe('服务访问必须安全（真机踩过）', () => {
  it('ctx 的代理对未 inject 的键抛错时，不因此崩溃', async () => {
    // 复刻 Cordis 的行为：访问未 inject 的服务键直接抛
    const ctx = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'get') return () => undefined;
          throw new Error(`cannot get property "${String(property)}" without inject`);
        },
      },
    ) as never;

    const sources = [source('p', [{ code: 'x', severity: 'warn' }])];

    // 不应抛错：分类器取不到就跳过分析
    const outcome = await new HealthSupervisor(ctx, sources).run();

    expect(outcome.grouped).toHaveLength(1);
    expect(outcome.analysis).toBeUndefined();
  });

  it('ctx 没有 get 方法时退回属性访问也不抛错', async () => {
    const ctx = {} as never;
    const outcome = await new HealthSupervisor(ctx, [source('p', [{ code: 'y', severity: 'warn' }])]).run();

    expect(outcome.grouped).toHaveLength(1);
    expect(outcome.analysis).toBeUndefined();
  });
});
