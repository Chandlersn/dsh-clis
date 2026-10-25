import type { CausalProblem, FourAnswers, TriState } from '@clis/clis-contracts';

export const Y: TriState = 'yes';
export const N: TriState = 'no';
export const U: TriState = 'unknown';

/** 按 Q1..Q4 顺序拼出四问作答。 */
export function answers(q1: TriState, q2: TriState, q3: TriState, q4: TriState): FourAnswers {
  return {
    q1_simultaneous_mutual_definition: q1,
    q2_delayed_mutual_influence: q2,
    q3_strict_irreversible_order: q3,
    q4_coexisting_causal_structures: q4,
  };
}

/** 造一个结构化问题；子问题用 withSubProblems 追加。 */
export function problem(
  q1: TriState,
  q2: TriState,
  q3: TriState,
  q4: TriState,
  options: { description?: string; label?: string; sub_problems?: CausalProblem[] } = {},
): CausalProblem {
  const base: CausalProblem = {
    description: options.description ?? '示例问题描述',
    answers: answers(q1, q2, q3, q4),
  };

  const withLabel: CausalProblem = options.label === undefined ? base : { ...base, label: options.label };
  return options.sub_problems === undefined
    ? withLabel
    : { ...withLabel, sub_problems: options.sub_problems };
}