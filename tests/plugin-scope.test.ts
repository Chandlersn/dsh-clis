/**
 * 回归：**只监管非内部插件**。
 *
 * 用户明确要求（2026-10-26）：「只监管非内部插件」。
 *
 * 背景：真机跑出 183 个"覆盖缺口"，其中 90% 是宿主内建服务
 * （llm / session / storage / ui-* …）。它们本来就不该有健康探针——
 * 那是基础设施，不健康时整个宿主就崩了，轮不到插件探针来报。
 *
 * 把 183 条内建服务报成"盲区"的后果：用户认为功能坏了，直接关掉；
 * 真正的信号（某个用户插件没探针）被淹没。
 *
 * 本用例钉住 isBuiltin 的判据与 buildScope 的统计口径。
 */
import { describe, expect, it } from 'vitest';

import {
  buildScope,
  isBuiltin,
  listPlugins,
  type DiscoveredPlugin,
} from '../packages/clis-plugin/src/plugin-scope';

/** 造一个探针来源。 */
function probe(plugin: string) {
  return {
    plugin,
    probe: async () => ({ plugin, status: 'ok' as const, findings: [] }),
  };
}

/** 造 loader 上下文。 */
function loaderCtx(entries: Array<{ id: string; state: number }>) {
  const list = entries.map((item) => ({
    options: { id: item.id },
    fiber: { state: item.state },
  }));
  return { loader: { entries: () => list.values() } } as never;
}

describe('宿主内建服务的判定', () => {
  it('官方作用域一律算内建', () => {
    expect(isBuiltin('@deepseek-ai/dsh-base')).toBe(true);
    expect(isBuiltin('@deepseek-ai/cordis')).toBe(true);
    expect(isBuiltin('@any/scope')).toBe(true);
  });

  it('常见宿主内建服务算内建', () => {
    // 这些是真机上出现过的，全都不该被监督
    for (const id of [
      'llm',
      'session',
      'storage',
      'ui-chat',
      'ui-sidebar',
      'tool-agent-team',
      'agent-loop',
      'plugin-manager',
      'sandbox-policy',
      'subagent-spawn-in-process',
      'web-startup',
      'cordis-inspect-providers',
    ]) {
      expect(isBuiltin(id), `${id} 应判为内建`).toBe(true);
    }
  });

  it('dsh- 开头的是用户插件（不判内建）', () => {
    // 这是本项目里第三方插件的约定命名 —— 必须参与监督
    for (const id of [
      'dsh-clis',
      'dsh-memory-manager',
      'dsh-session-tools',
      'dsh-learning-mode',
      'dsh-workbuddy-channels',
    ]) {
      expect(isBuiltin(id), `${id} 不应判为内建`).toBe(false);
    }
  });

  it('匿名随机 id 算内建（loader 生成，不是真插件）', () => {
    expect(isBuiltin('b7cfde4f')).toBe(true);
    expect(isBuiltin('8abd20c7')).toBe(true);
  });

  it('未知形态保守判为用户插件（宁可多监督，不可漏掉）', () => {
    // 判错方向必须保守：漏掉用户插件 = 它永远不被监督，代价更大
    expect(isBuiltin('some-unknown-third-party-plugin')).toBe(false);
  });

  it('真机误判的 10 条内建（段名在中间，首版漏判）', () => {
    // 首版只做前缀匹配，这些全被当成用户插件混进告警。
    // 现在用子串匹配收掉。
    for (const id of [
      'deepseek-llm-api-extensions',
      'user-questions',
      'deepseek-account',
      'working-directory',
      'subprocess',
      'pwsh-sandbox',
      'ptc-runtime',
      'system-prompt',
      'open-in-app',
      'directory-picker',
      'job-controller',
      'api-remotes',
      'office-to-pdf',
      'experimental-inspector',
    ]) {
      expect(isBuiltin(id), `${id} 应判为内建`).toBe(true);
    }
  });

  it('真机的真用户插件不被误判成内建', () => {
    // 这些必须参与监督 —— 误判会让它们永远不被检查
    for (const id of [
      'dsh-market',
      'our-free-model',
      'workbuddy-channels',
      'auto-review',
      'clis-classifier',
      'clis-tools',
    ]) {
      expect(isBuiltin(id), `${id} 不应判为内建`).toBe(false);
    }
  });
});

describe('listPlugins 标注 external', () => {
  it('内建与用户插件被正确区分', () => {
    const ctx = loaderCtx([
      { id: 'llm', state: 2 },
      { id: 'ui-chat', state: 2 },
      { id: 'dsh-clis', state: 2 },
      { id: 'dsh-memory-manager', state: 2 },
    ]);

    const found = listPlugins(ctx);
    const byId = new Map(found.map((item) => [item.id, item.external]));

    expect(byId.get('llm')).toBe(false);
    expect(byId.get('ui-chat')).toBe(false);
    expect(byId.get('dsh-clis')).toBe(true);
    expect(byId.get('dsh-memory-manager')).toBe(true);
  });

  it('宿主没有 loader 时安全降级', () => {
    expect(listPlugins({} as never)).toEqual([]);
  });
});

describe('buildScope 只统计非内建插件', () => {
  /** 一批混合插件。 */
  const mixed: DiscoveredPlugin[] = [
    { id: 'llm', state: 2, external: false },
    { id: 'session', state: 2, external: false },
    { id: 'ui-chat', state: 2, external: false },
    { id: 'storage', state: 2, external: false },
    { id: 'dsh-clis', state: 2, external: true },
    { id: 'dsh-memory-manager', state: 2, external: true },
    { id: 'dsh-session-tools', state: 2, external: true },
    { id: 'dsh-learning-mode', state: 2, external: true },
  ];

  it('externalTotal 只数用户插件', () => {
    const { externalTotal, activeTotal } = buildScope(mixed, []);
    expect(activeTotal).toBe(8);
    expect(externalTotal).toBe(4);
  });

  it('uncovered 只包含用户插件（不报内建服务）', () => {
    const { uncovered } = buildScope(mixed, [probe('dsh-clis')]);

    expect(uncovered).toEqual([
      'dsh-memory-manager',
      'dsh-session-tools',
      'dsh-learning-mode',
    ]);
    // 关键：内建服务一个都不该出现
    expect(uncovered).not.toContain('llm');
    expect(uncovered).not.toContain('ui-chat');
    expect(uncovered).not.toContain('session');
  });

  it('全部用户插件都有探针时 uncovered 为空', () => {
    const { uncovered } = buildScope(mixed, [
      probe('dsh-clis'),
      probe('dsh-memory-manager'),
      probe('dsh-session-tools'),
      probe('dsh-learning-mode'),
    ]);
    expect(uncovered).toEqual([]);
  });

  it('未激活的用户插件不算监督对象', () => {
    const plugins: DiscoveredPlugin[] = [
      { id: 'dsh-active', state: 2, external: true },
      { id: 'dsh-inactive', state: 0, external: true },
    ];

    const { externalTotal, uncovered } = buildScope(plugins, []);
    expect(externalTotal).toBe(1);
    expect(uncovered).toEqual(['dsh-active']);
  });
});

describe('真机场景复现：183 条降到个位数', () => {
  it('典型 profile（内建占绝大多数）只报用户插件缺口', () => {
    // 模拟真机：170 个内建 + 6 个用户插件
    const builtins: DiscoveredPlugin[] = Array.from({ length: 170 }, (_, i) => ({
      id: `builtin-service-${i}`,
      state: 2,
      external: false,
    }));
    const users: DiscoveredPlugin[] = [
      { id: 'dsh-clis', state: 2, external: true },
      { id: 'dsh-memory-manager', state: 2, external: true },
      { id: 'dsh-session-tools', state: 2, external: true },
      { id: 'dsh-learning-mode', state: 2, external: true },
      { id: 'dsh-workbuddy-channels', state: 2, external: true },
      { id: 'dshmarket', state: 2, external: true },
    ];

    const { activeTotal, externalTotal, uncovered } = buildScope(
      [...builtins, ...users],
      [probe('dsh-clis'), probe('dsh-memory-manager')],
    );

    expect(activeTotal).toBe(176);
    // 关键：只报 4 个用户插件，而不是 176 个
    expect(externalTotal).toBe(6);
    expect(uncovered).toHaveLength(4);
    expect(uncovered).toEqual([
      'dsh-session-tools',
      'dsh-learning-mode',
      'dsh-workbuddy-channels',
      'dshmarket',
    ]);
  });
});
