/**
 * 冒烟验证：用真实 Cordis Context 装载打包产物，确认四服务全可用。
 *
 * 这一步是"能不能装进宿主"的前置闸门 —— 打包成功不等于能加载。
 */
import { Context } from '@deepseek-ai/cordis';

import * as plugin from '../bundle/clis.js';

const REQUIRED_SERVICES = [
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalFeedback',
  'clis.causalOrchestrator',
];

const problem = {
  description: '火导致热：A→B 严格先后、不可逆',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'yes',
    q4_coexisting_causal_structures: 'no',
  },
};

const failures = [];

// ① 入口三件套
if (plugin.name !== 'clis') failures.push(`name 期望 'clis'，实际 ${plugin.name}`);
if (!Array.isArray(plugin.inject)) failures.push('inject 必须是数组');
if (typeof plugin.apply !== 'function') failures.push('apply 必须是函数');

// ② 装载后四服务可用
const ctx = new Context();
await ctx.plugin(plugin);

for (const serviceName of REQUIRED_SERVICES) {
  if (ctx[serviceName] === undefined) failures.push(`服务缺失：${serviceName}`);
}

// ③ 真的能跑一轮完整闭环
if (failures.length === 0) {
  const result = await ctx['clis.causalOrchestrator'].run(problem, {
    executor: { execute: async () => ({ status: 'ok', detail: 'smoke 执行器' }) },
  });

  if (result.classification?.causal_type !== 'unidirectional') {
    failures.push(`类型期望 unidirectional，实际 ${result.classification?.causal_type}`);
  }
  if (result.outcome !== 'effective') {
    failures.push(`outcome 期望 effective，实际 ${result.outcome}`);
  }
  if (!Array.isArray(result.state?.traces) || result.state.traces.length < 1) {
    failures.push('trace 缺失');
  }
}

// ④ 卸载后服务消失
await ctx.fiber.dispose();
for (const serviceName of REQUIRED_SERVICES) {
  if (ctx[serviceName] !== undefined) failures.push(`卸载后服务仍在：${serviceName}`);
}

if (failures.length > 0) {
  console.error('SMOKE FAIL');
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}

console.log('SMOKE PASS');
console.log(`  服务：${REQUIRED_SERVICES.join(', ')}`);
console.log('  闭环：classify → match → execute → feedback → decide 全部跑通');
console.log('  卸载：服务随 fiber 正确移除');
