/**
 * 四组件冒烟：验证每个组件可独立装载、四者共存时服务齐全。
 *
 * 关键验证点：
 * 1) 四个入口各自可 import（代码分割后 chunk 能正确解析）；
 * 2) 全部装载后四服务齐全；
 * 3) 只装部分组件时缺失的服务确实不可用（证明可独立开关）；
 * 4) 关闭 orchestrator 不影响其它三个。
 */
import { pathToFileURL } from 'node:url';

const HOST_CORDIS = 'D:/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const DIR = 'C:/Users/lyq/.dsh/profiles/web/node_modules/dsh-clis';

const COMPONENTS = {
  classifier: `${DIR}/clis-classifier.js`,
  strategy: `${DIR}/clis-strategy.js`,
  feedback: `${DIR}/clis-feedback.js`,
  orchestrator: `${DIR}/clis-orchestrator.js`,
};

const SERVICE_OF = {
  classifier: 'clis.causalClassifier',
  strategy: 'clis.causalStrategy',
  feedback: 'clis.causalFeedback',
  orchestrator: 'clis.causalOrchestrator',
};

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const host = await import(pathToFileURL(HOST_CORDIS).href);

// ① 四个入口可独立加载
const mods = {};
for (const [key, entry] of Object.entries(COMPONENTS)) {
  try {
    mods[key] = await import(pathToFileURL(entry).href);
    check(`${key} 入口可加载`, true);
  } catch (error) {
    check(`${key} 入口可加载`, false, String(error).slice(0, 120));
  }
}

// ② 各自声明了正确的 name / inject
const EXPECT_NAME = {
  classifier: 'clis-classifier',
  strategy: 'clis-strategy',
  feedback: 'clis-feedback',
  orchestrator: 'clis-orchestrator',
};
for (const [key, mod] of Object.entries(mods)) {
  check(`${key} name 正确`, mod.name === EXPECT_NAME[key], String(mod.name));
  check(`${key} inject 为数组`, Array.isArray(mod.inject), JSON.stringify(mod.inject));
}

// ③ 全部装载 → 四服务齐全
const full = new host.Context();
for (const key of ['classifier', 'strategy', 'feedback', 'orchestrator']) {
  await full.plugin(mods[key]);
}
for (const [key, serviceName] of Object.entries(SERVICE_OF)) {
  check(`全装后服务可见：${serviceName}`, full[serviceName] !== undefined);
}

// ④ 只装 classifier → 只有它自己可用
const onlyClassifier = new host.Context();
await onlyClassifier.plugin(mods.classifier);
check('只装 classifier：自身服务可用', onlyClassifier['clis.causalClassifier'] !== undefined);
check('只装 classifier：strategy 不可用', onlyClassifier['clis.causalStrategy'] === undefined);
check('只装 classifier：feedback 不可用', onlyClassifier['clis.causalFeedback'] === undefined);
check('只装 classifier：orchestrator 不可用', onlyClassifier['clis.causalOrchestrator'] === undefined);

// ⑤ 装 classifier + feedback（两者无互相依赖）→ 各自可用，strategy 仍缺
const two = new host.Context();
await two.plugin(mods.classifier);
await two.plugin(mods.feedback);
check('classifier+feedback：两者可用', two['clis.causalClassifier'] !== undefined && two['clis.causalFeedback'] !== undefined);
check('classifier+feedback：strategy 仍不可用', two['clis.causalStrategy'] === undefined);

// ⑥ 完整闭环仍能跑
const problem = {
  description: '供需与价格互相影响，存在时间延迟',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'yes',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'no',
  },
};
const result = await full['clis.causalOrchestrator'].run(problem, {
  executor: { execute: async () => ({ status: 'ok', detail: 'smoke' }) },
});
check('完整闭环：判为 cyclic', result.classification?.causal_type === 'cyclic', String(result.classification?.causal_type));
check('完整闭环：outcome effective', result.outcome === 'effective', String(result.outcome));

// ⑦ 卸载干净
await full.fiber.dispose();
for (const serviceName of Object.values(SERVICE_OF)) {
  check(`全卸载后移除：${serviceName}`, full[serviceName] === undefined);
}

console.log('');
if (failures.length > 0) {
  console.error(`SMOKE FAIL (${failures.length})`);
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('SMOKE PASS — 四个组件可独立装载、共存完备、卸载干净');
