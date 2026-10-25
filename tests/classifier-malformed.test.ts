/**
 * SPEC §3 输入校验 / §6 验证方第 9 项 —— 畸形输入必须抛 ClisContractError 且 code 正确，
 * 绝不返回兜底结论。
 */
import { describe, expect, it } from 'vitest';

import { ClisContractError } from '@clis/clis-contracts';
import type { ClassifyOptions, ClisContractErrorCode, CausalProblem } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';

import { answer4, captureContractError, makeProblem } from './helpers';

const VALID_ANSWERS = answer4('yes', 'no', 'no', 'no');

interface BadCase {
  readonly name: string;
  readonly input: unknown;
  readonly code: ClisContractErrorCode;
  readonly options?: unknown;
  /** 若给出：details 中至少一条 path 必须含该字段名（SPEC §3 "字段级 path"）。 */
  readonly fieldPath?: string;
}

const cases: readonly BadCase[] = [
  // --- INVALID_PROBLEM ---
  { name: 'problem 为 null', input: null, code: 'INVALID_PROBLEM' },
  { name: 'problem 为 undefined', input: undefined, code: 'INVALID_PROBLEM' },
  { name: 'problem 为字符串', input: 'causal problem', code: 'INVALID_PROBLEM' },
  { name: 'problem 为数字', input: 42, code: 'INVALID_PROBLEM' },
  {
    name: 'description 缺失',
    input: { answers: VALID_ANSWERS },
    code: 'INVALID_PROBLEM',
    fieldPath: 'description',
  },
  {
    name: 'description 不是字符串',
    input: { description: 5, answers: VALID_ANSWERS },
    code: 'INVALID_PROBLEM',
    fieldPath: 'description',
  },
  {
    name: 'sub_problems 不是数组',
    input: { description: '', answers: VALID_ANSWERS, sub_problems: 'not-an-array' },
    code: 'INVALID_PROBLEM',
    fieldPath: 'sub_problems',
  },
  {
    name: 'sub_problems 元素不是合法 problem',
    input: makeProblem('no', 'no', 'no', 'yes', { sub_problems: [42 as unknown as CausalProblem] }),
    code: 'INVALID_PROBLEM',
  },
  {
    name: 'label 存在但不是字符串',
    input: { description: '', answers: VALID_ANSWERS, label: 7 },
    code: 'INVALID_PROBLEM',
    fieldPath: 'label',
  },
  {
    name: '子问题 label 存在但不是字符串',
    input: makeProblem('no', 'no', 'no', 'yes', {
      sub_problems: [
        { description: '', answers: VALID_ANSWERS, label: 7 } as unknown as CausalProblem,
      ],
    }),
    code: 'INVALID_PROBLEM',
  },

  // --- INVALID_ANSWERS ---
  {
    name: 'answers 缺失',
    input: { description: '' },
    code: 'INVALID_ANSWERS',
    fieldPath: 'answers',
  },
  {
    name: 'answers 不是对象（数字）',
    input: { description: '', answers: 42 },
    code: 'INVALID_ANSWERS',
    fieldPath: 'answers',
  },
  {
    name: 'answers 不是对象（null）',
    input: { description: '', answers: null },
    code: 'INVALID_ANSWERS',
    fieldPath: 'answers',
  },
  {
    name: 'answers 不是对象（字符串）',
    input: { description: '', answers: 'yes' },
    code: 'INVALID_ANSWERS',
    fieldPath: 'answers',
  },
  {
    name: 'answers 缺 q1',
    input: {
      description: '',
      answers: {
        q2_delayed_mutual_influence: 'no',
        q3_strict_irreversible_order: 'no',
        q4_coexisting_causal_structures: 'no',
      },
    },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q1',
  },
  {
    name: 'answers 缺 q4',
    input: {
      description: '',
      answers: {
        q1_simultaneous_mutual_definition: 'yes',
        q2_delayed_mutual_influence: 'no',
        q3_strict_irreversible_order: 'no',
      },
    },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q4',
  },
  {
    name: 'answers q2 非法三态值 maybe',
    input: { description: '', answers: { ...VALID_ANSWERS, q2_delayed_mutual_influence: 'maybe' } },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q2_delayed_mutual_influence',
  },
  {
    name: 'answers q1 大小写不符（YES）',
    input: {
      description: '',
      answers: { ...VALID_ANSWERS, q1_simultaneous_mutual_definition: 'YES' },
    },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q1_simultaneous_mutual_definition',
  },
  {
    name: 'answers q3 为布尔值',
    input: { description: '', answers: { ...VALID_ANSWERS, q3_strict_irreversible_order: true } },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q3',
  },
  {
    name: 'answers q1 为空串',
    input: { description: '', answers: { ...VALID_ANSWERS, q1_simultaneous_mutual_definition: '' } },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q1',
  },
  {
    name: 'answers q4 为 null',
    input: {
      description: '',
      answers: { ...VALID_ANSWERS, q4_coexisting_causal_structures: null },
    },
    code: 'INVALID_ANSWERS',
    fieldPath: 'q4',
  },
  {
    name: '子问题 answers 不是对象',
    input: makeProblem('no', 'no', 'no', 'yes', {
      sub_problems: [{ description: '', answers: 42 } as unknown as CausalProblem],
    }),
    code: 'INVALID_ANSWERS',
    fieldPath: 'answers',
  },
  {
    name: '孙子问题 answers 缺 q3（深层递归校验）',
    input: makeProblem('no', 'no', 'no', 'yes', {
      sub_problems: [
        makeProblem('no', 'no', 'no', 'yes', {
          sub_problems: [
            {
              description: '',
              answers: {
                q1_simultaneous_mutual_definition: 'yes',
                q2_delayed_mutual_influence: 'no',
                q4_coexisting_causal_structures: 'no',
              },
            } as unknown as CausalProblem,
          ],
        }),
      ],
    }),
    code: 'INVALID_ANSWERS',
    fieldPath: 'q3',
  },

  // --- INVALID_OPTIONS ---
  {
    name: 'max_depth = -1',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: -1 },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = 99（超 MAX_DEPTH_LIMIT）',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: 99 },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = 8.5（非整数）',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: 8.5 },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = 1.5（非整数）',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: 1.5 },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = "3"（字符串）',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: '3' },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = true（布尔）',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: true },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
  {
    name: 'max_depth = NaN',
    input: makeProblem('yes', 'no', 'no', 'no'),
    options: { max_depth: Number.NaN },
    code: 'INVALID_OPTIONS',
    fieldPath: 'max_depth',
  },
];

describe('SPEC §3 / §6-9 畸形输入必须抛 ClisContractError 且 code 正确', () => {
  for (const badCase of cases) {
    it(`${badCase.name} ⇒ code = ${badCase.code}`, () => {
      const error = captureContractError(() =>
        classifierPlugin.classifyProblem(
          badCase.input as CausalProblem,
          badCase.options as ClassifyOptions | undefined,
        ),
      );

      expect(error).toBeInstanceOf(ClisContractError);
      expect(error.name).toBe('ClisContractError');
      expect(error.code).toBe(badCase.code);
      expect(error.message.length).toBeGreaterThan(0);

      // SPEC §3：details 必须给出字段级 path / expected / received
      expect(error.details.length).toBeGreaterThan(0);
      for (const detail of error.details) {
        expect(typeof detail.path).toBe('string');
        expect(typeof detail.expected).toBe('string');
        expect(typeof detail.received).toBe('string');
        expect(detail.path.length).toBeGreaterThan(0);
      }
      if (badCase.fieldPath !== undefined) {
        const paths = error.details.map((detail) => detail.path).join(' | ');
        expect(paths).toContain(badCase.fieldPath);
      }
    });
  }
});

describe('SPEC §3 合法边界不得误报', () => {
  it('description 允许空串', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'no', 'no', 'no'));
    expect(result.causal_type).toBe('structural_duality');
    expect(result.confidence).toBe(0.9);
  });

  it('answers 多余的键被忽略（不抛错）', () => {
    const result = classifierPlugin.classifyProblem({
      description: '多余键',
      answers: { ...VALID_ANSWERS, q5_extra: 'yes', extra: 'no' },
    } as unknown as CausalProblem);
    expect(result.causal_type).toBe('structural_duality');
    expect(result.confidence).toBe(0.9);
  });

  it('max_depth 合法边界 0 / 1 / 3 / 8 均不抛错', () => {
    const input = makeProblem('no', 'no', 'no', 'yes', {
      sub_problems: [makeProblem('no', 'yes', 'no', 'no')],
    });
    for (const maxDepth of [0, 1, 3, 8]) {
      const result = classifierPlugin.classifyProblem(input, { max_depth: maxDepth });
      expect(result.causal_type).toBe('nested');
    }
  });

  it('空 options 对象等价于缺省（不抛错）', () => {
    const input = makeProblem('yes', 'no', 'no', 'no');
    expect(classifierPlugin.classifyProblem(input, {})).toStrictEqual(
      classifierPlugin.classifyProblem(input),
    );
  });
});