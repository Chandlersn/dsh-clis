import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_CEILING,
  ClisContractError,
  KNOWN_CAUSAL_TYPES,
  TRI_STATES,
} from '@clis/clis-contracts';
import type {
  CausalClassification,
  CausalProblem,
  ClassifyOptions,
  FourAnswers,
} from '@clis/clis-contracts';

import { classifyProblem } from '@clis/clis-classifier';

import { N, U, Y, answers, problem } from './fixtures';

/** 取一次调用抛出的契约错误码；不抛或抛别的都算失败。 */
function contractErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ClisContractError) return error.code;
    throw new Error(`期望抛 ClisContractError，实际抛出 ${String(error)}`);
  }
  throw new Error('期望抛 ClisContractError，但没有任何异常抛出');
}

/** 81 种四问组合的穷举输入，用于验证"任何输入都成立"的不变量。 */
const ALL_ANSWERS: FourAnswers[] = [];
for (const q1 of TRI_STATES) {
  for (const q2 of TRI_STATES) {
    for (const q3 of TRI_STATES) {
      for (const q4 of TRI_STATES) {
        ALL_ANSWERS.push(answers(q1, q2, q3, q4));
      }
    }
  }
}

const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'];

describe('SPEC §4.1 置信度数值表', () => {
  it('R2：唯一 yes，未定项 0/1/2/3 个 ⇒ 0.9 / 0.82 / 0.74 / 0.66', () => {
    const cases = [
      { target: problem(Y, N, N, N), confidence: 0.9, needsExploration: false },
      { target: problem(Y, N, U, N), confidence: 0.82, needsExploration: false },
      { target: problem(Y, N, U, U), confidence: 0.74, needsExploration: false },
      { target: problem(Y, U, U, U), confidence: 0.66, needsExploration: true },
    ];

    for (const item of cases) {
      const result = classifyProblem(item.target);
      expect(result.causal_type).toBe('structural_duality');
      expect(result.confidence).toBe(item.confidence);
      expect(result.needs_exploration).toBe(item.needsExploration);
    }
  });

  it('R1：Q4 为是，未定项 0/3 个 ⇒ 0.9 / 0.66', () => {
    const strong = classifyProblem(problem(N, N, N, Y));
    expect(strong.causal_type).toBe('nested');
    expect(strong.confidence).toBe(0.9);
    expect(strong.needs_exploration).toBe(false);

    const weak = classifyProblem(problem(U, U, U, Y));
    expect(weak.causal_type).toBe('nested');
    expect(weak.confidence).toBe(0.66);
    expect(weak.needs_exploration).toBe(true);
  });

  it('R3：结构冲突，未定项 0/1 个 ⇒ 0.75 / 0.67（跨过 0.7 门槛）', () => {
    const clean = classifyProblem(problem(Y, Y, N, N));
    expect(clean.causal_type).toBe('nested');
    expect(clean.confidence).toBe(0.75);
    expect(clean.needs_exploration).toBe(false);

    const fuzzy = classifyProblem(problem(Y, Y, U, N));
    expect(fuzzy.causal_type).toBe('nested');
    expect(fuzzy.confidence).toBe(0.67);
    expect(fuzzy.needs_exploration).toBe(true);
  });

  it('R4：四问全否 ⇒ 0.4；含未定 ⇒ 0.25，两者都进探索模式', () => {
    const allNo = classifyProblem(problem(N, N, N, N));
    expect(allNo.causal_type).toBe('unknown');
    expect(allNo.confidence).toBe(0.4);
    expect(allNo.needs_exploration).toBe(true);

    const incomplete = classifyProblem(problem(N, N, N, U));
    expect(incomplete.causal_type).toBe('unknown');
    expect(incomplete.confidence).toBe(0.25);
    expect(incomplete.needs_exploration).toBe(true);
  });
});

describe('SPEC §4.2 unknown 的候选假设', () => {
  it('四问全否：四种类型齐全、各 0.3、降序且同分保持类型表顺序', () => {
    const result = classifyProblem(problem(N, N, N, N));
    const candidates = result.candidate_hypotheses;
    expect(candidates).toBeDefined();
    expect(candidates?.map((item) => item.causal_type)).toStrictEqual([...KNOWN_CAUSAL_TYPES]);
    for (const item of candidates ?? []) {
      expect(item.confidence).toBe(0.3);
      expect(item.rationale.length).toBeGreaterThan(0);
    }
  });

  it('含未定：各 0.2，排序仍与类型表一致', () => {
    const result = classifyProblem(problem(U, U, U, U));
    expect(result.candidate_hypotheses?.map((item) => item.causal_type)).toStrictEqual([
      ...KNOWN_CAUSAL_TYPES,
    ]);
    for (const item of result.candidate_hypotheses ?? []) {
      expect(item.confidence).toBe(0.2);
    }
  });

  it('非 unknown 结论时该字段不存在', () => {
    for (const target of [problem(Y, N, N, N), problem(N, Y, N, N), problem(N, N, N, Y)]) {
      const result = classifyProblem(target);
      expect('candidate_hypotheses' in result).toBe(false);
    }
  });
});

describe('SPEC §5 证据不变量', () => {
  it('穷举 81 种输入：证据恒非空、statement 非空、weight 在 [0,1]', () => {
    for (const target of ALL_ANSWERS) {
      const result = classifyProblem({ description: '穷举输入', answers: target });
      expect(result.evidence.length).toBeGreaterThan(0);
      for (const item of result.evidence) {
        expect(item.statement.trim().length).toBeGreaterThan(0);
        expect(item.weight).toBeGreaterThanOrEqual(0);
        expect(item.weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('每条 yes 作答各产生一条证据，且末尾恒有主判据证据', () => {
    const result = classifyProblem(problem(Y, Y, N, N));
    const yesSources = result.evidence.filter((item) => item.source === 'Q1' || item.source === 'Q2');
    expect(yesSources).toHaveLength(2);
    for (const item of yesSources) expect(item.weight).toBe(1);

    const last = result.evidence.at(-1);
    expect(last?.source).toBe('RULE');
    expect(last?.weight).toBe(result.confidence);
  });

  it('unknown 时逐问给出作答状态证据；description 非空时再给一条描述证据', () => {
    const withDescription = classifyProblem(problem(U, U, U, U, { description: '信息不足' }));
    const stateEvidence = withDescription.evidence.filter(
      (item) => item.source === 'Q1' || item.source === 'Q2' || item.source === 'Q3' || item.source === 'Q4',
    );
    expect(stateEvidence).toHaveLength(4);
    expect(withDescription.evidence.some((item) => item.source === 'DESCRIPTION')).toBe(true);

    const emptyDescription = classifyProblem({
      description: '',
      answers: answers(U, U, U, U),
    });
    expect(emptyDescription.evidence.some((item) => item.source === 'DESCRIPTION')).toBe(false);
    expect(emptyDescription.evidence.length).toBeGreaterThan(0);
  });

  it('description 证据截断到 120 字符并补省略号', () => {
    const long = '甲'.repeat(200);
    const result = classifyProblem({ description: long, answers: answers(U, U, U, U) });
    const descriptionEvidence = result.evidence.find((item) => item.source === 'DESCRIPTION');
    expect(descriptionEvidence).toBeDefined();
    expect(descriptionEvidence?.statement).toBe(`问题描述：${'甲'.repeat(120)}…`);
  });
});

describe('SPEC §4 规则轨迹与不变量', () => {
  it('judgment_basis 恒含 R1..R11 各一次', () => {
    for (const target of [
      problem(Y, N, N, N),
      problem(N, N, N, N),
      problem(Y, Y, N, N),
      problem(N, N, N, Y),
      problem(U, U, U, U),
    ]) {
      const ids = classifyProblem(target).judgment_basis.map((item) => item.rule_id);
      expect(ids).toStrictEqual(RULE_IDS);
    }
  });

  it('未触发规则不带 effect；触发规则必带非空 effect', () => {
    for (const target of ALL_ANSWERS) {
      const result = classifyProblem({ description: '穷举输入', answers: target });
      for (const item of result.judgment_basis) {
        if (item.fired) {
          expect(typeof item.effect).toBe('string');
          expect(item.effect?.trim().length ?? 0).toBeGreaterThan(0);
        } else {
          expect('effect' in item).toBe(false);
        }
      }
    }
  });

  it('穷举 81 种输入：置信度落在 (0, 0.9]，永不为 1.0', () => {
    for (const target of ALL_ANSWERS) {
      const result = classifyProblem({ description: '穷举输入', answers: target });
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING);
      expect(result.confidence).not.toBe(1);
    }
  });

  it('needs_exploration 恰为 confidence < 0.7，且 exploration_reason 存在性与之严格同号', () => {
    for (const target of ALL_ANSWERS) {
      const result = classifyProblem({ description: '穷举输入', answers: target });
      expect(result.needs_exploration).toBe(result.confidence < 0.7);
      if (result.needs_exploration) {
        expect(result.exploration_reason?.trim().length ?? 0).toBeGreaterThan(0);
      } else {
        expect('exploration_reason' in result).toBe(false);
      }
    }
  });

  it('sub_modules 字段恰在 nested 时出现，其余类型不存在', () => {
    for (const target of ALL_ANSWERS) {
      const result = classifyProblem({ description: '穷举输入', answers: target });
      expect('sub_modules' in result).toBe(result.causal_type === 'nested');
    }
  });

  it('同一输入连续两次结论深度相等（确定性）', () => {
    for (const target of ALL_ANSWERS) {
      const input = { description: '确定性检查', answers: target };
      expect(classifyProblem(input)).toStrictEqual(classifyProblem(input));
    }
  });
});

describe('SPEC §4.3 嵌套拆分与深度上限', () => {
  const cyclicSub = problem(N, Y, N, N, { description: '供需环' });
  const unidirectionalSub = problem(N, N, Y, N, { description: '雨导致地湿' });

  it('有子问题时递归分类，名称取 label 或 sub-N', () => {
    const labelled = classifyProblem(
      problem(N, N, N, Y, { sub_problems: [cyclicSub, unidirectionalSub] }),
    );
    expect(labelled.sub_modules?.map((module) => module.name)).toStrictEqual(['sub-1', 'sub-2']);
    expect(labelled.sub_modules?.map((module) => module.classification.causal_type)).toStrictEqual([
      'cyclic',
      'unidirectional',
    ]);
    expect(labelled.evidence.some((item) => item.source === 'SUBMODULE')).toBe(true);

    const named = classifyProblem(
      problem(N, N, N, Y, {
        sub_problems: [problem(N, Y, N, N, { label: '供需环' })],
      }),
    );
    expect(named.sub_modules?.map((module) => module.name)).toStrictEqual(['供需环']);
  });

  it('无子问题时 sub_modules 为空数组（字段仍存在）', () => {
    const result = classifyProblem(problem(N, N, N, Y));
    expect(result.sub_modules).toStrictEqual([]);
    const r10 = result.judgment_basis.find((item) => item.rule_id === 'R10');
    expect(r10?.fired).toBe(true);
  });

  it('max_depth = 0 时根为 nested 也不下探', () => {
    const result = classifyProblem(
      problem(N, N, N, Y, { sub_problems: [cyclicSub] }),
      { max_depth: 0 },
    );
    expect(result.sub_modules).toStrictEqual([]);
  });

  it('max_depth 限制递归层数：max_depth=1 时子模块不再展开', () => {
    const inner = problem(N, N, N, Y, {
      label: 'inner',
      sub_problems: [problem(N, Y, N, N, { label: 'innermost' })],
    });
    const root = problem(N, N, N, Y, { sub_problems: [inner] });

    const one = classifyProblem(root, { max_depth: 1 });
    expect(one.sub_modules).toHaveLength(1);
    expect(one.sub_modules?.[0]?.classification.sub_modules).toStrictEqual([]);

    const two = classifyProblem(root, { max_depth: 2 });
    expect(two.sub_modules?.[0]?.classification.sub_modules).toHaveLength(1);
    expect(two.sub_modules?.[0]?.classification.sub_modules?.[0]?.name).toBe('innermost');
  });

  it('非 nested 结论即使带了 sub_problems 也不拆分', () => {
    const result = classifyProblem(
      problem(N, Y, N, N, { sub_problems: [unidirectionalSub] }),
    );
    expect(result.causal_type).toBe('cyclic');
    expect('sub_modules' in result).toBe(false);
  });
});

describe('输入校验：畸形输入必须抛契约错误', () => {
  it('answers 缺字段或非三态 ⇒ INVALID_ANSWERS', () => {
    const missing = {
      description: '缺字段',
      answers: {
        q1_simultaneous_mutual_definition: 'yes',
        q2_delayed_mutual_influence: 'no',
        q3_strict_irreversible_order: 'no',
      },
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(missing))).toBe('INVALID_ANSWERS');

    const illegal = {
      description: '非法值',
      answers: { ...answers(Y, N, N, N), q2_delayed_mutual_influence: 'maybe' },
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(illegal))).toBe('INVALID_ANSWERS');

    const notObject = {
      description: 'answers 不是对象',
      answers: 'yes',
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(notObject))).toBe('INVALID_ANSWERS');
  });

  it('description 缺失/非字符串、sub_problems 非数组、label 非字符串 ⇒ INVALID_PROBLEM', () => {
    const noDescription = { answers: answers(N, N, N, N) } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(noDescription))).toBe('INVALID_PROBLEM');

    const badSubProblems = {
      description: 'sub_problems 非数组',
      answers: answers(N, N, N, Y),
      sub_problems: 'nope',
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(badSubProblems))).toBe('INVALID_PROBLEM');

    const badLabel = {
      description: 'label 非字符串',
      answers: answers(N, N, N, N),
      label: 42,
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(badLabel))).toBe('INVALID_PROBLEM');

    const badSubProblem = {
      description: '子问题畸形',
      answers: answers(N, N, N, Y),
      sub_problems: [{ description: '坏子问题', answers: { q1_simultaneous_mutual_definition: 'yes' } }],
    } as unknown as CausalProblem;
    expect(contractErrorCode(() => classifyProblem(badSubProblem))).toBe('INVALID_ANSWERS');
  });

  it('max_depth 非 [0, 8] 内的整数 ⇒ INVALID_OPTIONS', () => {
    const target = problem(N, N, N, N);
    for (const max_depth of [-1, 9, 99, 1.5, Number.NaN, '3']) {
      const options = { max_depth } as unknown as ClassifyOptions;
      expect(contractErrorCode(() => classifyProblem(target, options))).toBe('INVALID_OPTIONS');
    }
    // 边界内的值必须可用。
    expect(classifyProblem(target, { max_depth: 0 }).causal_type).toBe('unknown');
    expect(classifyProblem(target, { max_depth: 8 }).causal_type).toBe('unknown');
  });

  it('契约错误带字段级 details', () => {
    const broken = {
      description: '缺字段',
      answers: { q1_simultaneous_mutual_definition: 'yes' },
    } as unknown as CausalProblem;
    try {
      classifyProblem(broken);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ClisContractError);
      const contractError = error as ClisContractError;
      expect(contractError.details.length).toBeGreaterThan(0);
      expect(contractError.details.map((detail) => detail.path)).toContain(
        'problem.answers.q2_delayed_mutual_influence',
      );
    }
  });
});

describe('职责边界（SPEC §1）', () => {
  it('分类结论只谈类型，不携带任何策略或执行产物', () => {
    const result: CausalClassification = classifyProblem(problem(N, Y, N, N));
    const keys = Object.keys(result);
    for (const forbidden of ['strategy', 'paths', 'candidate_paths', 'execution', 'rollback']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});