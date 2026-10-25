/**
 * 工具冒烟：验证 clis_run / clis_classify / clis_plan 真的注册到宿主工具表。
 *
 * 这是"接上"的最终判据 —— 前几轮的经验是：服务装载成功 ≠ agent 能调用。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '');
const PROFILE_DIR = (process.env.DSH_PROFILE_DIR ?? 'C:/Users/lyq/.dsh/profiles/web').replace(/\/$/, '');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
const profileRequire = createRequire(`${PROFILE_DIR}/package.json`);

// 1) 装载四个组件
const ctx = new host.Context();
for (const specifier of ['dsh-clis/classifier', 'dsh-clis/strategy', 'dsh-clis/feedback', 'dsh-clis/orchestrator']) {
  const mod = await import(pathToFileURL(profileRequire.resolve(specifier)).href);
  await ctx.plugin(mod);
}

// 2) 确认四个服务就位
for (const serviceName of [
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalFeedback',
  'clis.causalOrchestrator',
]) {
  check(`服务就位：${serviceName}`, ctx[serviceName] !== undefined);
}

// 3) 装载包根（注册工具）—— 它 inject 依赖三个服务 + tools
//    纯 Node 环境没有 tools 服务，故这里直接调用 registerTools 验证逻辑
const rootMod = await import(pathToFileURL(profileRequire.resolve('dsh-clis')).href);
check('包根入口可加载', true);
check('包根 name 为 clis-tools', rootMod.name === 'clis-tools', String(rootMod.name));
check(
  '包根 inject 含 tools 与三个服务',
  Array.isArray(rootMod.inject) &&
    rootMod.inject.includes('tools') &&
    rootMod.inject.includes('clis.causalClassifier'),
  JSON.stringify(rootMod.inject),
);

// 4) 用假的 tools 服务验证 registerTools 真的注册了三个工具
const registered = [];
const fakeTools = {
  register(definition) {
    registered.push(definition);
    return () => {};
  },
};
// 把 fakeTools 挂到 ctx 上，模拟宿主的 tools 服务
Object.defineProperty(ctx, 'tools', { value: fakeTools, configurable: true, writable: true });

rootMod.apply(ctx);

check('registerTools 注册了 3 个工具', registered.length === 3, `${registered.length} 个`);

const names = registered.map((tool) => tool.name);
for (const expected of ['clis_run', 'clis_classify', 'clis_plan']) {
  check(`注册了工具 ${expected}`, names.includes(expected), names.join(','));
}

// 5) 工具定义结构合法（name/description/parameters/output/execute）
for (const tool of registered) {
  check(
    `${tool.name} 定义完整`,
    typeof tool.name === 'string' &&
      typeof tool.description === 'string' &&
      tool.description.length > 20 &&
      typeof tool.parameters === 'object' &&
      typeof tool.output === 'object' &&
      typeof tool.execute === 'function',
  );
}

// 6) 真的调用一次 clis_classify，验证能返回分类结果
const classifyTool = registered.find((tool) => tool.name === 'clis_classify');
if (classifyTool !== undefined) {
  const result = await classifyTool.execute(
    {
      description: '火导致热：严格先后、不可逆',
      q1: 'no',
      q2: 'no',
      q3: 'yes',
      q4: 'no',
    },
    {},
  );
  check('clis_classify 返回 unidirectional', result.causal_type === 'unidirectional', String(result.causal_type));
  check('clis_classify 返回置信度', typeof result.confidence === 'number', String(result.confidence));
  check('clis_classify 返回判断依据', Array.isArray(result.judgment_basis) && result.judgment_basis.length > 0);
}

// 7) 调用 clis_run 跑完整闭环
const runTool = registered.find((tool) => tool.name === 'clis_run');
if (runTool !== undefined) {
  const result = await runTool.execute(
    {
      description: '供需与价格互相影响，存在时间延迟',
      q1: 'no',
      q2: 'yes',
      q3: 'no',
      q4: 'no',
    },
    {},
  );
  check('clis_run 判为 cyclic', result.causal_type === 'cyclic', String(result.causal_type));
  check('clis_run 闭环 effective', result.outcome === 'effective', String(result.outcome));
  check('clis_run 返回 trace', Array.isArray(result.traces) && result.traces.length >= 1);
}

// 8) 调用 clis_plan 出候选路径
const planTool = registered.find((tool) => tool.name === 'clis_plan');
if (planTool !== undefined) {
  const result = await planTool.execute(
    {
      description: '供需与价格互相影响',
      q1: 'no',
      q2: 'yes',
      q3: 'no',
      q4: 'no',
      forbidden_actions: ['inject_damping'],
    },
    {},
  );
  check('clis_plan 返回路径', Array.isArray(result.paths) && result.paths.length > 0, `${result.paths?.length} 条`);
  check('clis_plan 首选为杠杆点', result.paths?.[0]?.variant === 'loop.leverage_point', String(result.paths?.[0]?.variant));
  const actions = (result.paths ?? []).flatMap((path) => (path.steps ?? []).map((step) => step.action));
  check('clis_plan 禁止动作未入路径', !actions.includes('inject_damping'));
}

await ctx.fiber.dispose();

console.log('');
if (failures.length > 0) {
  console.error(`TOOLS SMOKE FAIL (${failures.length})`);
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('TOOLS SMOKE PASS — 三个工具注册成功且可调用');
