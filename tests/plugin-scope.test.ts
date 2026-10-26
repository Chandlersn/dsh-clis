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
 *
 * 另加：**自动探针层**（autoSources）—— 用户指出「应该是 clis 自己就知道加，
 * 如果不是这样的机制，那后续增加的插件它也不可能知道」。故自动层必须
 * 对**全部**非内建插件生效，不依赖插件是否导出探针。
 */
import { describe, expect, it } from 'vitest';

import {
  autoSources,
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
  /** 造一个插件条目（补齐自动监督所需的字段）。 */
  function dp(id: string, external: boolean, state = 2): DiscoveredPlugin {
    return {
      id,
      state,
      external,
      disabled: false,
      declaredInject: [],
      probeExport: undefined,
      live: undefined,
    };
  }

  /** 一批混合插件。 */
  const mixed: DiscoveredPlugin[] = [
    dp('llm', false),
    dp('session', false),
    dp('ui-chat', false),
    dp('storage', false),
    dp('dsh-clis', true),
    dp('dsh-memory-manager', true),
    dp('dsh-session-tools', true),
    dp('dsh-learning-mode', true),
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
    const plugins: DiscoveredPlugin[] = [dp('dsh-active', true), dp('dsh-inactive', true, 0)];

    const { externalTotal, uncovered } = buildScope(plugins, []);
    expect(externalTotal).toBe(1);
    expect(uncovered).toEqual(['dsh-active']);
  });
});

describe('真机场景复现：183 条降到个位数', () => {
  it('典型 profile（内建占绝大多数）只报用户插件缺口', () => {
    /** 造条目。 */
    const mk = (id: string, external: boolean): DiscoveredPlugin => ({
      id,
      state: 2,
      external,
      disabled: false,
      declaredInject: [],
      probeExport: undefined,
      live: undefined,
    });

    // 模拟真机：170 个内建 + 6 个用户插件
    const builtins: DiscoveredPlugin[] = Array.from({ length: 170 }, (_, i) =>
      mk(`builtin-service-${i}`, false),
    );
    const users: DiscoveredPlugin[] = [
      mk('dsh-clis', true),
      mk('dsh-memory-manager', true),
      mk('dsh-session-tools', true),
      mk('dsh-learning-mode', true),
      mk('dsh-workbuddy-channels', true),
      mk('dshmarket', true),
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

describe('自动探针层：插件不配合也要被覆盖', () => {
  /** 造条目（含自动监督所需字段）。 */
  function mk(
    id: string,
    extra: Partial<Pick<DiscoveredPlugin, 'state' | 'external' | 'disabled' | 'declaredInject' | 'probeExport' | 'live'>> = {},
  ): DiscoveredPlugin {
    return {
      id,
      state: 2,
      external: true,
      disabled: false,
      declaredInject: [],
      probeExport: undefined,
      live: undefined,
      ...extra,
    };
  }

  /** 只提供 ctx.get 的最小上下文。 */
  const ctx = {
    get: (name: string) => (name === 'tools' ? {} : undefined),
  } as never;

  it('未导出探针的插件也拿到结构探针（覆盖 100%）', () => {
    const { sources, total, structuralOnly } = autoSources(
      ctx,
      [mk('dsh-a'), mk('dsh-b'), mk('dsh-c')],
      [],
    );

    expect(total).toBe(3);
    expect(sources).toHaveLength(3);
    expect(structuralOnly).toEqual(['dsh-a', 'dsh-b', 'dsh-c']);
  });

  it('导出了探针的插件走协作层（信号更丰富）', async () => {
    const exported = {
      probe: async () => ({ status: 'degraded', findings: [{ code: 'x.y', severity: 'warn', message: '领域问题' }] }),
    };

    const { sources, domainCovered, structuralOnly } = autoSources(
      ctx,
      [mk('dsh-a', { probeExport: exported })],
      [],
    );

    expect(domainCovered).toContain('dsh-a');
    expect(structuralOnly).toEqual([]);

    const report = await sources[0]!.probe();
    expect(report.findings[0]?.code).toBe('x.y');
  });

  it('工厂形态也支持（函数返回 { probe() }）', async () => {
    const factory = () => ({
      probe: async () => ({ status: 'ok', findings: [] }),
    });

    const { sources, domainCovered } = autoSources(ctx, [mk('dsh-a', { probeExport: factory })], []);
    expect(domainCovered).toContain('dsh-a');

    const report = await sources[0]!.probe();
    expect(report.status).toBe('ok');
  });

  it('内建插件不进自动层（不报也不需要探针）', () => {
    const { total, sources } = autoSources(ctx, [mk('llm', { external: false }), mk('dsh-a')], []);
    expect(total).toBe(1);
    expect(sources.map((item) => item.plugin)).toEqual(['dsh-a']);
  });

  it('显式关闭的插件不进监督（那是用户意图，不是盲区）', () => {
    const { total } = autoSources(ctx, [mk('dsh-a', { disabled: true }), mk('dsh-b')], []);
    expect(total).toBe(1);
  });

  it('名称归一化：dsh-x 与 x 是同一个插件，不重复探测', () => {
    // 真机踩到：memory-manager 自报 'dsh-memory-manager'，loader id 是
    // 'memory-manager' —— 不归一化会各跑一次
    const { sources } = autoSources(
      ctx,
      [mk('memory-manager', { probeExport: { probe: async () => ({ status: 'ok', findings: [] }) } })],
      [probe('dsh-memory-manager')],
    );

    // 显式注册的胜出，导出探针不再叠加
    expect(sources).toHaveLength(1);
    expect(sources[0]?.plugin).toBe('dsh-memory-manager');
  });
});

describe('自动结构探针的检查项', () => {
  /** 只提供 ctx.get 的上下文。 */
  function ctxWith(services: string[]) {
    return { get: (name: string) => (services.includes(name) ? {} : undefined) } as never;
  }

  /** 造条目。 */
  function mk(id: string, state: number, declaredInject: string[] = []): DiscoveredPlugin {
    return {
      id,
      state,
      external: true,
      disabled: false,
      declaredInject,
      probeExport: undefined,
      live: undefined,
    };
  }

  it('卡在装载 → auto.fiber-loading（warn）', async () => {
    const { sources } = autoSources(ctxWith([]), [mk('dsh-stuck', 1)], []);
    const report = await sources[0]!.probe();

    expect(report.status).toBe('degraded');
    expect(report.findings[0]?.code).toBe('auto.fiber-loading');
  });

  it('意外未激活 → auto.fiber-inactive（warn）', async () => {
    const { sources } = autoSources(ctxWith([]), [mk('dsh-dead', 0)], []);
    const report = await sources[0]!.probe();

    expect(report.findings[0]?.code).toBe('auto.fiber-inactive');
  });

  it('依赖未满足 → auto.missing-dependency（error）', async () => {
    const { sources } = autoSources(ctxWith(['tools']), [mk('dsh-broken', 2, ['tools', 'ghost'])], []);
    const report = await sources[0]!.probe();

    expect(report.status).toBe('failing');
    expect(report.findings[0]?.code).toBe('auto.missing-dependency');
    expect(report.findings[0]?.message).toContain('ghost');
  });

  it('一切正常 → ok 且无发现', async () => {
    const { sources } = autoSources(ctxWith(['tools']), [mk('dsh-ok', 2, ['tools'])], []);
    const report = await sources[0]!.probe();

    expect(report.status).toBe('ok');
    expect(report.findings).toHaveLength(0);
  });

  it('坏掉的导出探针变成可读发现（不让整个互查塌掉）', async () => {
    // 导出探针抛错 → 必须转成一条 finding，而不是让汇总塌掉
    const exported = {
      probe: async () => {
        throw new Error('探针内部炸了');
      },
    };

    const { sources } = autoSources(ctxWith([]), [mk('dsh-x', 2)], []);
    void sources;

    const withExport = autoSources(ctxWith([]), [
      {
        id: 'dsh-y',
        state: 2,
        external: true,
        disabled: false,
        declaredInject: [],
        probeExport: exported,
        live: undefined,
      },
    ]);

    const result = await withExport.sources[0]!.probe();
    expect(result.status).toBe('failing');
    expect(result.findings[0]?.code).toBe('auto.probe-broken');
    expect(result.findings[0]?.message).toContain('探针内部炸了');
  });
});
