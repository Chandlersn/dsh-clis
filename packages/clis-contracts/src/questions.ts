import type { KnownCausalType } from './causal-type';

/**
 * 四问的作答状态。
 * 故意只用三态：作答本身不携带概率，概率由判据规则统一计算，
 * 这样"同一条规则算出同一个数"是可复现的。
 */
export const TRI_STATES = ['yes', 'no', 'unknown'] as const;

export type TriState = (typeof TRI_STATES)[number];

export type QuestionId = 'Q1' | 'Q2' | 'Q3' | 'Q4';

/** 四个自答字段：结构化输入的主体。 */
export interface FourAnswers {
  /** Q1：A 与 B 是否同时成立、彼此定义、且无时间先后？ */
  readonly q1_simultaneous_mutual_definition: TriState;
  /** Q2：是否存在带时间延迟的相互影响（A→B→A）？ */
  readonly q2_delayed_mutual_influence: TriState;
  /** Q3：是否 A→B 严格先后且不可逆？ */
  readonly q3_strict_irreversible_order: TriState;
  /** Q4：系统中是否同时存在多种因果结构（需拆子模块）？ */
  readonly q4_coexisting_causal_structures: TriState;
}

export type AnswerKey = keyof FourAnswers;

/** 一条"问—答—类型"的绑定。 */
export interface QuestionSpec {
  readonly id: QuestionId;
  readonly answer_key: AnswerKey;
  /** 该问题回答 yes 时指向的类型。 */
  readonly resolves_to: KnownCausalType;
  readonly text: string;
}

/** 四问的唯一权威定义：契约、实现、验收共用同一张表，不许各写一份。 */
export const FOUR_QUESTIONS: readonly QuestionSpec[] = [
  {
    id: 'Q1',
    answer_key: 'q1_simultaneous_mutual_definition',
    resolves_to: 'structural_duality',
    text: 'A 与 B 是否同时成立、彼此定义、且无时间先后？',
  },
  {
    id: 'Q2',
    answer_key: 'q2_delayed_mutual_influence',
    resolves_to: 'cyclic',
    text: '是否存在带时间延迟的相互影响（A→B→A）？',
  },
  {
    id: 'Q3',
    answer_key: 'q3_strict_irreversible_order',
    resolves_to: 'unidirectional',
    text: '是否 A→B 严格先后且不可逆？',
  },
  {
    id: 'Q4',
    answer_key: 'q4_coexisting_causal_structures',
    resolves_to: 'nested',
    text: '系统中是否同时存在多种因果结构（需拆子模块）？',
  },
];

/** 四问的作答字段名，顺序即 Q1..Q4。 */
export const ANSWER_KEYS: readonly AnswerKey[] = FOUR_QUESTIONS.map((question) => question.answer_key);

export function isTriState(value: unknown): value is TriState {
  return typeof value === 'string' && (TRI_STATES as readonly string[]).includes(value);
}