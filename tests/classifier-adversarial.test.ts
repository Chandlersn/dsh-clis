/**
 * SPEC §6 验证方第 5 项「反例优先」—— SPEC 未逐字列举、但受同一不变量约束的输入。
 *
 * 本文件是首轮 93 条套件全绿之后**追加**的（只新增断言，未改动任何既有断言）：
 * 首轮套件对 §4.3 R9「R1/R3 且存在 sub_problems」只覆盖了 R1 根，这里补上 R3 根递归、
 * 双层嵌套子问题，以及 depth 上限的精确切断点。
 */
import { describe, expect, it } from 'vitest';

import type {
  CausalClassification,
  CausalType,
} from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';

import {
  expectInvariants,
  expectMainRuleEvidence,
  invariantViolations,
  makeProblem,
  ruleTrace,
} from './helpers';

const structural = (): CausalClassification =>
  classifierPlugin.classifyProblem(makeProblem('yes', 'no', 'no', 'no'));
const cyclic = (): CausalClassification =>
  classifierPlugin.classifyProblem(makeProblem('no', 'yes', 'no', 'no'));

function typeChain(node: CausalClassification, steps: number): CausalType[] {
  const types: CausalType[] = [];
  let current: CausalClassification | undefined = node;
  for (let index = 0; index < steps; index += 1) {
    if (!current) break;
    types.push(current.causal_type);
    current = current.sub_modules?.[0]?.classification;
  }
  return types;
}

describe('反例优先 A：R9 也适用于 R3 根（Q4≠yes 但 d≥2）', () => {
  const grandChild = makeProblem('yes', 'no', 'no', 'no');
  const nestedChild = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [grandChild] });
  const cyclicChild = makeProblem('no', 'yes', 'no', 'no');
  const root = makeProblem('yes', 'yes', 'no', 'no', {
    description: 'R3 冲突根带子问题',
    sub_problems: [cyclicChild, nestedChild],
  });

  it('R3 根仍按 R9 递归拆分：sub_modules 长度 2，根 confidence 仍为 0.75', () => {
    const result = classifierPlugin.classifyProblem(root);
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.75);
    expect(result.needs_exploration).toBe(false);
    expect(ruleTrace(result, 'R3').fired).toBe(true);
    expect(ruleTrace(result, 'R9').fired).toBe(true);

    const subModules = result.sub_modules ?? [];
    expect(subModules.length).toBe(2);
    expect(subModules.map((module) => module.name)).toStrictEqual(['sub-1', 'sub-2']);
    expect(subModules[0]?.classification.causal_type).toBe('cyclic');
    expect(subModules[0]?.classification.confidence).toBe(0.9);
    expect(subModules[1]?.classification.causal_type).toBe('nested');
    expect(subModules[1]?.classification.confidence).toBe(0.9);

    // 孙层继续递归
    const grand = subModules[1]?.classification.sub_modules ?? [];
    expect(grand.length).toBe(1);
    expect(grand[0]?.name).toBe('sub-1');
    expect(grand[0]?.classification.causal_type).toBe('structural_duality');
    expect(grand[0]?.classification.confidence).toBe(0.9);

    // 拆分证据 + 末尾主判据仍指着 R3
    const submoduleEvidence = result.evidence.filter((item) => item.source === 'SUBMODULE');
    expect(submoduleEvidence.length).toBe(1);
    expect(submoduleEvidence[0]?.statement).toContain('2');
    expect(submoduleEvidence[0]?.statement).toContain('sub-1');
    expect(submoduleEvidence[0]?.statement).toContain('sub-2');
    expectMainRuleEvidence(result, 'R3');
    expectInvariants(result, 'R3+subs');
  });

  it('R3 根的冲突证据与主判据证据分工不变（RULE 恰 2 条，主判据在末尾）', () => {
    const result = classifierPlugin.classifyProblem(root);
    const ruleEvidence = result.evidence.filter((item) => item.source === 'RULE');
    expect(ruleEvidence.length).toBe(2);
    expect(ruleEvidence[1]?.weight).toBe(0.75);
    expectMainRuleEvidence(result, 'R3');
  });
});

describe('反例优先 B：两个子问题各自又是嵌套（逐层 name 从 sub-1 重新编号）', () => {
  const leafA = makeProblem('no', 'yes', 'no', 'no');
  const leafB = makeProblem('no', 'no', 'yes', 'no');
  const childA = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [leafA] });
  const childB = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [leafB] });
  const root = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [childA, childB] });

  it('根两层子模块都是 nested，各自再拆一层，逐层编号均为 sub-1', () => {
    const result = classifierPlugin.classifyProblem(root);
    expect(result.causal_type).toBe('nested');
    const subModules = result.sub_modules ?? [];
    expect(subModules.length).toBe(2);

    for (const module of subModules) {
      expect(module.classification.causal_type).toBe('nested');
      expect(module.classification.confidence).toBe(0.9);
      const grandChildren = module.classification.sub_modules ?? [];
      expect(grandChildren.length).toBe(1);
      expect(grandChildren[0]?.name).toBe('sub-1');
      expectInvariants(module.classification, `${module.name}/child`);
    }
    expect(subModules[0]?.classification.sub_modules?.[0]?.classification.causal_type).toBe(
      'cyclic',
    );
    expect(subModules[1]?.classification.sub_modules?.[0]?.classification.causal_type).toBe(
      'unidirectional',
    );

    // 每一层都不得出现子模块证据以外的证据不变量破口
    const violations: string[] = [];
    const walk = (node: CausalClassification, label: string): void => {
      violations.push(...invariantViolations(node, label));
      (node.sub_modules ?? []).forEach((module, index) => {
        walk(module.classification, `${label}/${module.name}#${index}`);
      });
    };
    walk(result, 'root');
    expect(violations).toStrictEqual([]);
  });

  it('对照：单层子模块（无孙层）行为不变，避免上面的构造掩盖基线', () => {
    const flat = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', { sub_problems: [leafA, leafB] }),
    );
    expect(flat.sub_modules?.length).toBe(2);
    expect(flat.sub_modules?.[0]?.classification.sub_modules).toBeUndefined();
    expect(flat.sub_modules?.[1]?.classification.sub_modules).toBeUndefined();
  });
});

describe('反例优先 C：depth 切断点精确落在 max_depth 上（4 层链）', () => {
  // 链：root(0) → A(1) → B(2) → C(3) → D(4)
  const leafD = makeProblem('yes', 'no', 'no', 'no');
  const nodeC = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [leafD] });
  const nodeB = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [nodeC] });
  const nodeA = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [nodeB] });
  const root = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [nodeA] });

  it('max_depth = 3：第 4 层子问题（depth 3 的孩子）不再下探 ⇒ sub_modules = []', () => {
    const result = classifierPlugin.classifyProblem(root, { max_depth: 3 });
    // root 0 → A 1 → B 2 → C 3 全部出现
    expect(typeChain(result, 4)).toStrictEqual(['nested', 'nested', 'nested', 'nested']);
    const c = (result.sub_modules ?? [])[0]?.classification.sub_modules?.[0]?.classification
      .sub_modules?.[0]?.classification;
    expect(c?.causal_type).toBe('nested');
    expect(c?.sub_modules).toStrictEqual([]);
    // 第 4 层（D）不在输出里
    expect(c?.sub_modules?.length).toBe(0);
    expectInvariants(result, 'chain/max3');
  });

  it('max_depth = 4：第 4 层被纳入 ⇒ C.sub_modules 长度 1，D 为 structural_duality', () => {
    const result = classifierPlugin.classifyProblem(root, { max_depth: 4 });
    const c = (result.sub_modules ?? [])[0]?.classification.sub_modules?.[0]?.classification
      .sub_modules?.[0]?.classification;
    expect(c?.causal_type).toBe('nested');
    const d = c?.sub_modules?.[0]?.classification;
    expect(c?.sub_modules?.length).toBe(1);
    expect(d?.causal_type).toBe('structural_duality');
    expect(d?.confidence).toBe(0.9);
    expect(d?.sub_modules).toBeUndefined();
    expectInvariants(result, 'chain/max4');
  });

  it('max_depth = 2：depth 2 的节点不再下探，depth 1 的节点仍可下探一层', () => {
    const result = classifierPlugin.classifyProblem(root, { max_depth: 2 });
    const a = (result.sub_modules ?? [])[0]?.classification;
    expect(a?.causal_type).toBe('nested');
    expect(a?.sub_modules?.length).toBe(1);
    const b = a?.sub_modules?.[0]?.classification;
    expect(b?.causal_type).toBe('nested');
    expect(b?.sub_modules).toStrictEqual([]);
    expectInvariants(result, 'chain/max2');
  });

  it('同一棵树三种 max_depth 的根结论恒为 nested / 0.9（深度不改变自身判据）', () => {
    for (const maxDepth of [0, 1, 2, 3, 4, 8]) {
      const result = classifierPlugin.classifyProblem(root, { max_depth: maxDepth });
      expect(result.causal_type).toBe('nested');
      expect(result.confidence).toBe(0.9);
      expect(result.needs_exploration).toBe(false);
    }
  });

  it('max_depth = 0 时第 1 层子问题完全不出现在输出中（仅根结论）', () => {
    const result = classifierPlugin.classifyProblem(root, { max_depth: 0 });
    expect(result.sub_modules).toStrictEqual([]);
    expect(typeChain(result, 5)).toStrictEqual(['nested']);
    expectInvariants(result, 'chain/max0');
  });
});

describe('反例优先 D：类型与证据的交叉不变量在非典型路径上同样成立', () => {
  it('Q4=yes 且 Q1..Q3 全 no（§6-5 提到的例子）：nested / 0.9，无候选假设、有 sub_modules', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', { sub_problems: [makeProblem('no', 'yes', 'no', 'no')] }),
    );
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.9);
    expect(result.candidate_hypotheses).toBeUndefined();
    expect(result.sub_modules?.length).toBe(1);
    expect(ruleTrace(result, 'R1').fired).toBe(true);
    expect(ruleTrace(result, 'R3').fired).toBe(false);
  });

  it('R2 唯一 yes 落在 Q2 时，子问题递归仍按各自作答判定（父类型不传染）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'yes', 'no', 'no', { sub_problems: [makeProblem('no', 'no', 'no', 'yes')] }),
    );
    // R2 结论：非 nested ⇒ 不存在 sub_modules，即使给了 sub_problems
    expect(result.causal_type).toBe('cyclic');
    expect(result.sub_modules).toBeUndefined();
    expect(cyclic().confidence).toBe(result.confidence);
  });

  it('cyclic 子问题的 evidence 与结构性子问题一样恒非空（递归层不退化）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'yes', 'no', 'no'),
          makeProblem('unknown', 'unknown', 'no', 'no'),
        ],
      }),
    );
    const second = result.sub_modules?.[1]?.classification;
    expect(second?.causal_type).toBe('unknown');
    expect(second?.confidence).toBe(0.25);
    expect(second?.evidence.length).toBeGreaterThan(0);
    expect(second?.candidate_hypotheses?.length).toBe(4);
    expectInvariants(second as CausalClassification, 'child/R4');
    expect(structural().evidence.length).toBeGreaterThan(0);
  });
});