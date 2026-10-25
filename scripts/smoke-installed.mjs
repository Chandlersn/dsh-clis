/**
 * 常驻插件冒烟验证：模拟宿主的真实装载路径。
 *
 * 关键点：**用宿主那份 cordis 建 Context**，再装载已安装到 profile 的插件，
 * 以此验证「内联 cordis 不会造成两份注册表」这个最容易翻车的假设。
 *
 * 用法：
 *   node scripts/smoke-installed.mjs
 * 退出码 0 = 全部通过。
 */
import { pathToFileURL } from 'node:url';

const HOST_CORDIS = process.env.DSH_CORDIS_ENTRY || 'D:/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const PLUGIN_ENTRY =
  process.env.CLIS_PLUGIN_ENTRY ||
  'C:/Users/lyq/.dsh/profiles/web/node_modules/dsh-clis/index.js';

const SERVICES = [
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalFeedback',
  'clis.causalOrchestrator',
];

const failures = [];

function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

// ① 插件入口可被独立 import（不依赖宿主 Context）
const plugin = await import(pathToFileURL(PLUGIN_ENTRY).href);
check('插件可独立加载', true, PLUGIN_ENTRY.split('/').slice(-3).join('/'));
check('name === clis', plugin.name === 'clis', String(plugin.name));
check('inject 为数组', Array.isArray(plugin.inject));
check('apply 为函数', typeof plugin.apply === 'function');

// ② 宿主 Context 装载并可见四服务
const host = await import(pathToFileURL(HOST_CORDIS).href);
const ctx = new host.Context();
await ctx.plugin(plugin);

for (const serviceName of SERVICES) {
  check(`服务可见：${serviceName}`, ctx[serviceName] !== undefined);
}

// ③ 完整闭环
const problem = {
  description: '火导致热：A→B 严格先后、不可逆',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'yes',
    q4_coexisting_causal_structures: 'no',
  },
};

const result = await ctx['clis.causalOrchestrator'].run(problem, {
  executor: { execute: async () => ({ status: 'ok', detail: 'smoke' }) },
});

check('分类为 unidirectional', result.classification?.causal_type === 'unidirectional', String(result.classification?.causal_type));
check('闭环 outcome = effective', result.outcome === 'effective', String(result.outcome));
check('trace 非空', Array.isArray(result.state?.traces) && result.state.traces.length >= 1);

// ④ 边界生效：禁止动作不进路径
const classification = await ctx['clis.causalClassifier'].classify(problem);
const paths = await ctx['clis.causalStrategy'].match(classification, {
  forbidden_actions: ['trace_upstream'],
});
const allActions = paths.flatMap((p) => p.steps.map((s) => s.action));
check('禁止动作已从路径剔除', !allActions.includes('trace_upstream'));

// ⑤ 卸载干净
await ctx.fiber.dispose();
for (const serviceName of SERVICES) {
  check(`卸载后移除：${serviceName}`, ctx[serviceName] === undefined);
}

console.log('');
if (failures.length > 0) {
  console.error(`SMOKE FAIL (${failures.length})`);
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('SMOKE PASS — 插件可在宿主 Context 下正常工作');
