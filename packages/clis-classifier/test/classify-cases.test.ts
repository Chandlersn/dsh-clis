import { describe, expect, it } from 'vitest';

import { CONFIDENCE_CEILING } from '@clis/clis-contracts';

import { classifyProblem } from '@clis/clis-classifier';

import { N, U, Y, problem } from './fixtures';

/**
 * SPEC §6「实现方」要求的用例：结构对偶、循环因果、单向因果各 2 条，嵌套与 unknown 各 1 条。
 * 每条都断言：类型正确 + evidence 非空且每条 statement 非空。
 */
function expectTypeAndEvidence(
  result: ReturnType<typeof classifyProblem>,
  expectedType: string,
): void {
  expect(result.causal_type).toBe(expectedType);

  expect(Array.isArray(result.evidence)).toBe(true);
  expect(result.evidence.length).toBeGreaterThan(0);

  for (const item of result.evidence) {
    expect(typeof item.statement).toBe('string');
    expect(item.statement.trim().length).toBeGreaterThan(0);
    expect(item.weight).toBeGreaterThanOrEqual(0);
    expect(item.weight).toBeLessThanOrEqual(1);
  }

  expect(result.confidence).toBeGreaterThan(0);
  expect(result.confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING);
}

describe('结构对偶 structural_duality', () => {
  it('Q1 明确为是、其余明确为否 ⇒ 结构对偶，且证据充分', () => {
    const result = classifyProblem(problem(Y, N, N, N, { description: '正与反同时成立、彼此定义' }));
    expectTypeAndEvidence(result, 'structural_duality');
    expect(result.confidence).toBe(0.9);
  });

  it('Q1 为是而 Q3 未定 ⇒ 仍是结构对偶，但置信度下降且不进探索模式', () => {
    const result = classifyProblem(problem(Y, N, U, N, { description: '买与卖互为定义，无先后' }));
    expectTypeAndEvidence(result, 'structural_duality');
    expect(result.confidence).toBe(0.82);
    expect(result.needs_exploration).toBe(false);
  });
});

describe('循环因果 cyclic', () => {
  it('Q2 明确为是、其余明确为否 ⇒ 循环因果', () => {
    const result = classifyProblem(
      problem(N, Y, N, N, { description: '供需与价格互相影响，存在时间延迟' }),
    );
    expectTypeAndEvidence(result, 'cyclic');
    expect(result.confidence).toBe(0.9);
  });

  it('Q2 为是而 Q1 未定 ⇒ 仍是循环因果', () => {
    const result = classifyProblem(
      problem(U, Y, N, N, { description: '捕食者与猎物种群往复振荡' }),
    );
    expectTypeAndEvidence(result, 'cyclic');
    expect(result.confidence).toBe(0.82);
  });
});

describe('单向因果 unidirectional', () => {
  it('Q3 明确为是、其余明确为否 ⇒ 单向因果', () => {
    const result = classifyProblem(problem(N, N, Y, N, { description: '火导致热，严格先后且不可逆' }));
    expectTypeAndEvidence(result, 'unidirectional');
    expect(result.confidence).toBe(0.9);
  });

  it('Q3 为是而 Q4 未定 ⇒ 仍是单向因果', () => {
    const result = classifyProblem(problem(N, N, Y, U, { description: '下雨导致地面变湿' }));
    expectTypeAndEvidence(result, 'unidirectional');
    expect(result.confidence).toBe(0.82);
  });
});

describe('嵌套 nested', () => {
  it('Q4 明确为是 ⇒ 嵌套，且 sub_modules 字段存在', () => {
    const result = classifyProblem(problem(N, N, N, Y, { description: '系统内同时存在多种因果结构' }));
    expectTypeAndEvidence(result, 'nested');
    expect(result.confidence).toBe(0.9);
    expect(result.sub_modules).toBeDefined();
    expect(result.sub_modules).toStrictEqual([]);
  });
});

describe('未知 unknown', () => {
  it('四问全部未定 ⇒ unknown，不强行归类，给出候选假设', () => {
    const result = classifyProblem(problem(U, U, U, U, { description: '信息不足，无法判断' }));
    expectTypeAndEvidence(result, 'unknown');
    expect(result.causal_type).toBe('unknown');
    expect(result.confidence).toBe(0.25);
    expect(result.needs_exploration).toBe(true);
    expect(result.candidate_hypotheses).toHaveLength(4);
  });
});