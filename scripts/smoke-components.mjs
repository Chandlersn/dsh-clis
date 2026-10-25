/**
 * 四组件冒烟：验证每个组件可独立装载、四者共存时服务齐全且为宿主 Service 实例。
 *
 * 关键：必须从 **profile 目录** 解析裸说明符 `dsh-clis/...` —— 这正是宿主 Loader
 * 的解析上下文；从别处解析会得到 "Cannot find package"。
 * 另设 DSH_INSTALL_DIR 指向宿主安装目录，让 cordis shim 命中宿主那份
 * （否则会命中开发仓库自带的 devDependency，Service 身份不一致）。
 *
 * 用法：
 *   node scripts/smoke-components.mjs
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

const COMPONENTS = {
  classifier: 'dsh-clis/classifier',
  strategy: 'dsh-clis/strategy',
  feedback: 'dsh-clis/feedback',
  orchestrator: 'dsh-clis/orchestrator',
};

const SERVICE_OF = {
  classifier: 'clis.causalClassifier',
  strategy: 'clis.causalStrategy',
  feedback: 'clis.causalFeedback',
  orchestrator: 'clis.causalOrchestrator',
};

const EXPECT_NAME = {
  classifier: 'clis-classifier',
  strategy: 'clis-strategy',
  feedback: 'clis-feedback',
  orchestrator: 'clis-orchestrator',
};

// ① 包根可解析 —— Loader 靠它判定整包合法性，缺了整包会被跳过
try {
  profileRequire.resolve('dsh-clis');
  check('包根 exports["."] 可解析', true);
} catch (error) {
  check('包根 exports["."] 可解析', false, String(error.code));
}

// ② 四个子路径入口可加载
const mods = {};
for (const [key, specifier] of Object.entries(COMPONENTS)) {
  try {
    mods[key] = await import(pathToFileURL(profileRequire.resolve(specifier)).href);
    check(`${key} 入口可加载`, true);
  } catch (error) {
    check(`${key} 入口可加载`, false, String(error.code ?? error.message).slice(0, 100));
  }
}

// ③ name / inject 正确
for (const [key, mod] of Object.entries(mods)) {
  check(`${key} name 正确`, mod.name === EXPECT_NAME[key], String(mod.name));
  check(`${key} inject 为数组`, Array.isArray(mod.inject));
}

// ④ 全部装载 → 四服务齐全，且都是宿主 Service 实例
const full = new host.Context();
for (const mod of Object.values(mods)) await full.plugin(mod);

let mounted = 0;
for (const serviceName of Object.values(SERVICE_OF)) {
  const present = full[serviceName] !== undefined;
  check(`全装后服务可见：${serviceName}`, present);
  if (present) {
    mounted += 1;
    check(`${serviceName} 是宿主 Service 实例`, full[serviceName] instanceof host.Service);
  }
}
check('四个服务全部就位', mounted === 4, `${mounted}/4`);

// ⑤ 只装 classifier → 其余不可用（证明可独立开关）
const only = new host.Context();
await only.plugin(mods.classifier);
check('只装 classifier：自身可用', only['clis.causalClassifier'] !== undefined);
check('只装 classifier：strategy 不可用', only['clis.causalStrategy'] === undefined);
check('只装 classifier：orchestrator 不可用', only['clis.causalOrchestrator'] === undefined);

// ⑥ 完整闭环
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
  check(`卸载后移除：${serviceName}`, full[serviceName] === undefined);
}

console.log('');
if (failures.length > 0) {
  console.error(`SMOKE FAIL (${failures.length})`);
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('SMOKE PASS — 四组件可独立装载、服务为宿主实例、闭环可用、卸载干净');
