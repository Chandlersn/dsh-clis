/**
 * 工具冒烟：三工具在宿主真实管线内验证，返回值必须是无损 JSON。
 *
 * 为什么必须这样测（2026-10-26 审查教训）：
 * 此前冒烟用 fake tools 直调实现函数，全绿；但真机调用时宿主以
 * `value is not lossless JSON` 拒绝，工具实际不可用。
 * 根因是返回值里带 `undefined` 属性的可选字段。
 *
 * 因此本脚本做两件事：
 * 1. 通过插件真实注册路径（registerTools + mock tools 表）拿到 ToolDefinition；
 * 2. 调用 ToolDefinition.execute()，用**宿主的 isJsonValue** 校验返回值。
 *    isJsonValue 判非法 ⇒ 真实宿主会拒绝 ⇒ 本测试必须 FAIL。
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

// —— 加载宿主的两个关键件：cordis 与 isJsonValue ——
const hostReq = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostReq.resolve('@deepseek-ai/cordis')).href);

const utilReq = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh-util-values/lib/index.js`);
const util = await import(pathToFileURL(utilReq.resolve('@deepseek-ai/dsh-util-values')).href);
const isJson = util.isJsonValue;
check('host isJsonValue 可用', typeof isJson === 'function');

const profileRequire = createRequire(`${PROFILE_DIR}/package.json`);

// —— 装载四个组件 ——
const ctx = new host.Context();
for (const specifier of [
  'dsh-clis/classifier',
  'dsh-clis/strategy',
  'dsh-clis/feedback',
  'dsh-clis/orchestrator',
]) {
  const mod = await import(pathToFileURL(profileRequire.resolve(specifier)).href);
  await ctx.plugin(mod);
}

for (const serviceName of [
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalFeedback',
  'clis.causalOrchestrator',
]) {
  check(`服务就位：${serviceName}`, ctx[serviceName] !== undefined);
}

// —— 走插件真实注册路径：包根 apply 会调 registerTools ——
// 宿主真实环境里 tools 是服务；这里用一个记录型替身接住 ToolDefinition，
// 目的是拿到**生产代码里那份** definition，而不是测试里另写一份。
const definitions = {};
const toolStub = {
  register(definition) {
    definitions[definition.name] = definition;
    return () => {};
  },
};
Object.defineProperty(ctx, 'tools', {
  value: toolStub,
  configurable: true,
  writable: true,
});

const rootMod = await import(pathToFileURL(profileRequire.resolve('dsh-clis')).href);
check('包根 name 为 clis-tools', rootMod.name === 'clis-tools', String(rootMod.name));
rootMod.apply(ctx);

for (const expected of ['clis_run', 'clis_classify', 'clis_plan']) {
  check(`注册了工具 ${expected}`, definitions[expected] !== undefined);
}

/** 四问作答的公共部分。 */
const UNIDIRECTIONAL = { q1: 'no', q2: 'no', q3: 'yes', q4: 'no' };
const CYCLIC = { q1: 'no', q2: 'yes', q3: 'no', q4: 'no' };
const ALL_UNKNOWN = { q1: 'unknown', q2: 'unknown', q3: 'unknown', q4: 'unknown' };

/**
 * 执行一个工具并用宿主规则校验返回值。
 *
 * @param toolName 工具名。
 * @param args 工具入参。
 * @param label 断言标签。
 */
async function exercise(toolName, args, label) {
  const definition = definitions[toolName];
  if (definition === undefined) {
    check(`${label} 工具存在`, false);
    return;
  }

  try {
    const value = await definition.execute(args, {});
    const ok = isJson(value);
    check(`${label} 返回值无损 JSON`, ok);

    if (!ok) {
      // 指出具体哪个键是 undefined —— 这正是宿主拒绝的原因
      const offenders = [];
      const walk = (node, path) => {
        if (node === undefined) {
          offenders.push(path);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((item, index) => walk(item, `${path}[${index}]`));
          return;
        }
        if (node !== null && typeof node === 'object') {
          for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`);
        }
      };
      walk(value, '$');
      if (offenders.length > 0) console.log(`     undefined 键：${offenders.join(', ')}`);
    }
    return value;
  } catch (error) {
    check(`${label} 执行不抛错`, false, String(error?.message ?? error).slice(0, 120));
    return undefined;
  }
}

// —— 逐工具、逐形态验证 ——
const classified = await exercise(
  'clis_classify',
  { description: '火导致热：严格先后不可逆', ...UNIDIRECTIONAL },
  'clis_classify 单向',
);
check('clis_classify 判为 unidirectional', classified?.causal_type === 'unidirectional', String(classified?.causal_type));
check('clis_classify 置信度 ≤ 0.9', (classified?.confidence ?? 1) <= 0.9, String(classified?.confidence));

const unknownOut = await exercise(
  'clis_classify',
  { description: '完全不清楚是什么关系', ...ALL_UNKNOWN },
  'clis_classify 未知',
);
check('clis_classify 未知时不强行归类', unknownOut?.causal_type === 'unknown', String(unknownOut?.causal_type));
check('clis_classify 未知时要求探索', unknownOut?.needs_exploration === true);

const planned = await exercise(
  'clis_plan',
  { description: '价格与需求互相影响，有延迟', ...CYCLIC, forbidden_actions: ['inject_damping'] },
  'clis_plan 带边界',
);
check('clis_plan 首选为杠杆点', planned?.paths?.[0]?.variant === 'loop.leverage_point', String(planned?.paths?.[0]?.variant));
const plannedActions = (planned?.paths ?? []).flatMap((path) => (path.steps ?? []).map((step) => step.action));
check('clis_plan 禁止动作未进任何 steps', !plannedActions.includes('inject_damping'));
const dampedPath = (planned?.paths ?? []).find((path) => path.variant === 'loop.damping_injection');
check('clis_plan 被禁路径 executable=false', dampedPath?.executable === false, String(dampedPath?.executable));
check(
  'clis_plan 可执行路径排在不可执行之前',
  (planned?.paths ?? []).every((path, index, all) =>
    path.executable === false ? all.slice(index).every((later) => later.executable === false) : true,
  ),
);

const ran = await exercise(
  'clis_run',
  { description: '预热与命中率互相影响，有延迟', ...CYCLIC },
  'clis_run 闭环',
);
check('clis_run 判为 cyclic', ran?.causal_type === 'cyclic', String(ran?.causal_type));
check('clis_run 输出 trace', Array.isArray(ran?.traces) && ran.traces.length >= 1);
check('clis_run 带历史块', typeof ran?.history === 'object' && ran.history !== null);
check('clis_run 历史含提示', typeof ran?.history?.hint === 'string');

await ctx.fiber.dispose();

console.log('');
if (failures.length > 0) {
  console.error(`TOOLS SMOKE FAIL (${failures.length})`);
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('TOOLS SMOKE PASS — 三工具经真实注册路径可执行，返回值全部无损 JSON');
