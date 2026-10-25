import {
  ANSWER_KEYS,
  CONFIDENCE_CEILING,
  ClisContractError,
  DEFAULT_MAX_DEPTH,
  EXPLORATION_THRESHOLD,
  FOUR_QUESTIONS,
  KNOWN_CAUSAL_TYPES,
  MAX_DEPTH_LIMIT,
  isTriState,
  normalizeConfidence,
} from '@clis/clis-contracts';
import type {
  CandidateHypothesis,
  CausalClassification,
  CausalProblem,
  CausalType,
  ClassifyOptions,
  ClisContractErrorCode,
  ClisContractErrorDetail,
  Evidence,
  FourAnswers,
  JudgmentBasis,
  KnownCausalType,
  QuestionId,
  QuestionSpec,
  SubModuleClassification,
  TriState,
} from '@clis/clis-contracts';

/**
 * 判据规则表（SPEC §4）。规则 id 与描述在此固化，judgment_basis 里每条都会出现。
 * 规则只做"读作答 → 出结论"，不生成策略、不执行、不回退。
 */
const RULES = {
  R1: { rule_id: 'R1', description: 'Q4=yes：直接判为 nested' },
  R2: { rule_id: 'R2', description: 'Q4 非 yes 且 Q1..Q3 恰好一个 yes：判为该唯一类型' },
  R3: { rule_id: 'R3', description: 'Q4 非 yes 且 Q1..Q3 两个以上 yes：结构冲突，判为 nested' },
  R4: { rule_id: 'R4', description: '无任何 yes 且 Q4 非 yes：判为 unknown，不强行归类' },
  R5: { rule_id: 'R5', description: '每个 unknown 作答扣 0.08' },
  R6: { rule_id: 'R6', description: 'R3 触发时额外扣 0.15' },
  R7: { rule_id: 'R7', description: 'confidence < 0.7：标记 needs_exploration' },
  R8: { rule_id: 'R8', description: `confidence 限制在 [0, ${CONFIDENCE_CEILING}]` },
  R9: { rule_id: 'R9', description: 'nested 且有 sub_problems 且未达深度上限：递归生成 sub_modules' },
  R10: { rule_id: 'R10', description: 'nested 但无 sub_problems 或已达深度上限：sub_modules 为空数组' },
  R11: { rule_id: 'R11', description: 'unknown：输出候选假设（降序，同分按类型表顺序）' },
} as const;

type RuleId = keyof typeof RULES;

/** 数值化的类型名，仅用于人类可读的证据文本。 */
const TYPE_LABELS: Record<CausalType, string> = {
  structural_duality: '结构对偶',
  cyclic: '循环因果',
  unidirectional: '单向因果',
  nested: '嵌套',
  unknown: '未知',
};

const TRI_LABELS: Record<TriState, string> = {
  yes: '是',
  no: '否',
  unknown: '未定',
};

const UNKNOWN_PENALTY = 0.08;
const CONFLICT_PENALTY = 0.15;
const UNKNOWN_ALL_NO_CONFIDENCE = 0.4;
const UNKNOWN_INCOMPLETE_CONFIDENCE = 0.25;
const CANDIDATE_CONFIDENCE_ALL_NO = 0.3;
const CANDIDATE_CONFIDENCE_INCOMPLETE = 0.2;
const DESCRIPTION_EVIDENCE_LIMIT = 120;

/** 证据来源中允许的字面值。 */
type EvidenceSourceLiteral = QuestionId | 'DESCRIPTION' | 'SUBMODULE' | 'RULE';

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  const kind = typeof value;
  if (kind === 'string') {
    const text = value as string;
    return `string(${text.length <= 40 ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, 40))}…`})`;
  }
  if (kind === 'object') return 'object';
  return `${kind}(${String(value)})`;
}

function fail(
  code: ClisContractErrorCode,
  message: string,
  details: readonly ClisContractErrorDetail[],
): never {
  throw new ClisContractError(code, message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProblem(value: unknown, path: string): asserts value is CausalProblem {
  if (!isPlainObject(value)) {
    fail('INVALID_PROBLEM', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (typeof value.description !== 'string') {
    fail('INVALID_PROBLEM', `${path}.description 必须是字符串`, [
      {
        path: `${path}.description`,
        expected: 'string',
        received: describeReceived(value.description),
      },
    ]);
  }

  if (value.label !== undefined && typeof value.label !== 'string') {
    fail('INVALID_PROBLEM', `${path}.label 存在时必须是字符串`, [
      { path: `${path}.label`, expected: 'string | undefined', received: describeReceived(value.label) },
    ]);
  }

  assertAnswers(value.answers, `${path}.answers`);

  const subProblems = value.sub_problems;
  if (subProblems !== undefined) {
    if (!Array.isArray(subProblems)) {
      fail('INVALID_PROBLEM', `${path}.sub_problems 存在时必须是数组`, [
        {
          path: `${path}.sub_problems`,
          expected: 'array',
          received: describeReceived(subProblems),
        },
      ]);
    }
    subProblems.forEach((sub, index) => {
      assertProblem(sub, `${path}.sub_problems[${index}]`);
    });
  }
}

function assertAnswers(value: unknown, path: string): asserts value is FourAnswers {
  if (!isPlainObject(value)) {
    fail('INVALID_ANSWERS', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  const details: ClisContractErrorDetail[] = [];
  for (const key of ANSWER_KEYS) {
    const answer = value[key];
    if (!isTriState(answer)) {
      details.push({
        path: `${path}.${key}`,
        expected: "'yes' | 'no' | 'unknown'",
        received: describeReceived(answer),
      });
    }
  }

  if (details.length > 0) {
    fail('INVALID_ANSWERS', `${path} 存在缺失或非法的作答字段`, details);
  }
}

function resolveMaxDepth(options: ClassifyOptions | undefined): number {
  if (options === undefined) return DEFAULT_MAX_DEPTH;

  if (!isPlainObject(options)) {
    fail('INVALID_OPTIONS', 'options 必须是对象', [
      { path: 'options', expected: 'object', received: describeReceived(options) },
    ]);
  }

  const raw = options.max_depth;
  if (raw === undefined) return DEFAULT_MAX_DEPTH;

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_DEPTH_LIMIT) {
    fail('INVALID_OPTIONS', `options.max_depth 必须是 [0, ${MAX_DEPTH_LIMIT}] 内的整数`, [
      {
        path: 'options.max_depth',
        expected: `integer in [0, ${MAX_DEPTH_LIMIT}]`,
        received: describeReceived(raw),
      },
    ]);
  }

  return raw;
}

interface AnswerState {
  readonly spec: QuestionSpec;
  readonly answer: TriState;
}

interface Evaluated {
  readonly all: readonly AnswerState[];
  readonly q4: AnswerState;
  /** Q1..Q3 中回答 yes 的类型，互不重复。 */
  readonly positive: readonly KnownCausalType[];
  readonly unknownCount: number;
}

function evaluate(answers: FourAnswers): Evaluated {
  const pick = (id: QuestionId): AnswerState => {
    const spec = FOUR_QUESTIONS.find((question) => question.id === id);
    if (spec === undefined) {
      // 契约常量缺项属于契约自身的问题，不属于输入畸形。
      throw new ClisContractError('INVALID_PROBLEM', `契约缺少问题定义 ${id}`);
    }
    return { spec, answer: answers[spec.answer_key] };
  };

  const q1 = pick('Q1');
  const q2 = pick('Q2');
  const q3 = pick('Q3');
  const q4 = pick('Q4');
  const all: readonly AnswerState[] = [q1, q2, q3, q4];

  return {
    all,
    q4,
    positive: [q1, q2, q3]
      .filter((state) => state.answer === 'yes')
      .map((state) => state.spec.resolves_to),
    unknownCount: all.filter((state) => state.answer === 'unknown').length,
  };
}

type Decision =
  | { readonly kind: 'r1' }
  | { readonly kind: 'r2'; readonly type: KnownCausalType }
  | { readonly kind: 'r3' }
  | { readonly kind: 'r4' };

function decide(evaluated: Evaluated): Decision {
  const distinctPositive = evaluated.positive.length;

  if (evaluated.q4.answer === 'yes') return { kind: 'r1' };

  if (distinctPositive === 1) {
    const only = evaluated.positive[0];
    if (only !== undefined) return { kind: 'r2', type: only };
  }

  if (distinctPositive >= 2) return { kind: 'r3' };

  return { kind: 'r4' };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function yesEvidence(state: AnswerState): Evidence {
  return {
    source: state.spec.id,
    rule_id: `E-${state.spec.id}-YES`,
    statement: `${state.spec.id} 作答为「是」：${state.spec.text}`,
    supports: state.spec.resolves_to,
    weight: 1,
  };
}

function answerStateEvidence(state: AnswerState): Evidence {
  return {
    source: state.spec.id,
    rule_id: 'R4',
    statement: `${state.spec.id} 作答为「${TRI_LABELS[state.answer]}」：${state.spec.text}`,
    supports: 'unknown',
    weight: 0,
  };
}

function ruleEvidence(ruleId: RuleId, statement: string, supports: CausalType, weight: number): Evidence {
  return {
    source: 'RULE' satisfies EvidenceSourceLiteral,
    rule_id: ruleId,
    statement,
    supports,
    weight,
  };
}

function buildCandidates(unknownCount: number): CandidateHypothesis[] {
  const confidence =
    unknownCount === 0 ? CANDIDATE_CONFIDENCE_ALL_NO : CANDIDATE_CONFIDENCE_INCOMPLETE;
  const rationale =
    unknownCount === 0
      ? '四问均明确为否：仅作为待探索的备选假设'
      : '作答不完整，无法排除该类型';

  // Array.prototype.sort 自 ES2019 起稳定，因此同分项保持 KNOWN_CAUSAL_TYPES 的既定顺序。
  return KNOWN_CAUSAL_TYPES.map((causalType) => ({
    causal_type: causalType,
    confidence,
    rationale,
  })).sort((left, right) => right.confidence - left.confidence);
}

function basis(ruleId: RuleId, fired: boolean, effect: string): JudgmentBasis {
  const entry: JudgmentBasis & { effect?: string } = {
    rule_id: RULES[ruleId].rule_id,
    description: RULES[ruleId].description,
    fired,
  };
  if (fired) entry.effect = effect;
  return entry;
}

/** 可变草稿：仅在组装阶段使用，避免为"字段可缺省"写一堆条件类型。 */
interface DraftClassification {
  causal_type: CausalType;
  confidence: number;
  evidence: Evidence[];
  sub_modules?: SubModuleClassification[];
  judgment_basis: JudgmentBasis[];
  needs_exploration: boolean;
  exploration_reason?: string;
  candidate_hypotheses?: CandidateHypothesis[];
}

function classifyValidated(
  problem: CausalProblem,
  maxDepth: number,
  depth: number,
): CausalClassification {
  const evaluated = evaluate(problem.answers);
  const decision = decide(evaluated);
  const unknownCount = evaluated.unknownCount;

  const conflictPenalty = decision.kind === 'r3' ? CONFLICT_PENALTY : 0;
  const rawConfidence =
    decision.kind === 'r4'
      ? unknownCount === 0
        ? UNKNOWN_ALL_NO_CONFIDENCE
        : UNKNOWN_INCOMPLETE_CONFIDENCE
      : CONFIDENCE_CEILING - UNKNOWN_PENALTY * unknownCount - conflictPenalty;
  const confidence = normalizeConfidence(rawConfidence);

  const causalType: CausalType =
    decision.kind === 'r1' || decision.kind === 'r3'
      ? 'nested'
      : decision.kind === 'r2'
        ? decision.type
        : 'unknown';

  const needsExploration = confidence < EXPLORATION_THRESHOLD;

  // —— 证据组装（恒非空）——
  const evidence: Evidence[] = [];
  for (const state of evaluated.all) {
    if (state.answer === 'yes') evidence.push(yesEvidence(state));
  }

  if (decision.kind === 'r3') {
    const coexisting = evaluated.positive.map((type) => TYPE_LABELS[type]).join('、');
    evidence.push(
      ruleEvidence(
        'R3',
        `Q4 未确认为嵌套，但 Q1..Q3 中同时有「是」：${coexisting} 并存，属结构冲突，按 nested 处理`,
        'nested',
        1,
      ),
    );
  }

  if (decision.kind === 'r4') {
    for (const state of evaluated.all) evidence.push(answerStateEvidence(state));
    if (problem.description.trim().length > 0) {
      evidence.push({
        source: 'DESCRIPTION',
        rule_id: 'R4',
        statement: `问题描述：${truncate(problem.description, DESCRIPTION_EVIDENCE_LIMIT)}`,
        supports: 'unknown',
        weight: 0,
      });
    }
  }

  // —— 嵌套拆分（SPEC §4.3）——
  const subProblems = causalType === 'nested' ? (problem.sub_problems ?? []) : [];
  const subModules: SubModuleClassification[] = [];
  const depthExceeded = subProblems.length > 0 && depth + 1 > maxDepth;

  if (subProblems.length > 0 && !depthExceeded) {
    for (const [index, subProblem] of subProblems.entries()) {
      subModules.push({
        name: subProblem.label ?? `sub-${index + 1}`,
        classification: classifyValidated(subProblem, maxDepth, depth + 1),
      });
    }
  }

  if (subModules.length > 0) {
    evidence.push({
      source: 'SUBMODULE',
      rule_id: 'R9',
      statement: `已拆分为 ${subModules.length} 个子模块：${subModules
        .map((module) => module.name)
        .join('、')}`,
      supports: 'nested',
      weight: 1,
    });
  }

  const candidates = decision.kind === 'r4' ? buildCandidates(unknownCount) : undefined;

  const primaryRule: RuleId =
    decision.kind === 'r1' ? 'R1' : decision.kind === 'r2' ? 'R2' : decision.kind === 'r3' ? 'R3' : 'R4';

  // 末尾恒有一条主判据证据：即使前面一条证据都没生成，这一条也保证 evidence 非空。
  evidence.push(
    ruleEvidence(
      primaryRule,
      `主判据 ${primaryRule}：${RULES[primaryRule].description}；结论 ${TYPE_LABELS[causalType]}，置信度 ${confidence}`,
      causalType,
      confidence,
    ),
  );

  const judgmentBasis: JudgmentBasis[] = [
    basis('R1', decision.kind === 'r1', `判为 nested，confidence=${confidence}`),
    basis(
      'R2',
      decision.kind === 'r2',
      `判为 ${TYPE_LABELS[causalType]}，confidence=${confidence}`,
    ),
    basis('R3', decision.kind === 'r3', `结构冲突，判为 nested，confidence=${confidence}`),
    basis('R4', decision.kind === 'r4', `判为 unknown，confidence=${confidence}`),
    basis('R5', unknownCount > 0, `扣 ${UNKNOWN_PENALTY * unknownCount}（${unknownCount} 项未定）`),
    basis('R6', decision.kind === 'r3', `额外扣 ${CONFLICT_PENALTY}`),
    basis(
      'R7',
      needsExploration,
      `confidence=${confidence} < ${EXPLORATION_THRESHOLD}，needs_exploration=true`,
    ),
    basis('R8', true, `confidence 已限制在 [0, ${CONFIDENCE_CEILING}]`),
    basis('R9', subModules.length > 0, `生成 ${subModules.length} 个子模块`),
    basis(
      'R10',
      causalType === 'nested' && subModules.length === 0,
      subProblems.length === 0
        ? '无 sub_problems，sub_modules 为空数组'
        : `已达深度上限 max_depth=${maxDepth}，sub_modules 为空数组`,
    ),
    basis('R11', decision.kind === 'r4', `输出 ${candidates?.length ?? 0} 条候选假设`),
  ];

  const draft: DraftClassification = {
    causal_type: causalType,
    confidence,
    evidence,
    judgment_basis: judgmentBasis,
    needs_exploration: needsExploration,
  };

  if (causalType === 'nested') draft.sub_modules = subModules;
  if (candidates !== undefined) draft.candidate_hypotheses = candidates;
  if (needsExploration) {
    draft.exploration_reason =
      decision.kind === 'r4'
        ? unknownCount === 0
          ? '四问均明确为否：已排除四种已知类型，但无法给出类型，禁止强行归类'
          : `四问作答不足（${unknownCount} 项未定）：信息不足以判断类型`
        : `confidence=${confidence} 低于 ${EXPLORATION_THRESHOLD}：作答不完整或存在结构冲突，需进入探索模式`;
  }

  return draft;
}

/**
 * 判断因果类型 —— 纯函数：同步、确定性、无 I/O。
 *
 * 只读作答出结论，不生成策略、不执行动作、不回退；畸形输入抛 ClisContractError。
 *
 * @param problem — 结构化问题（描述 + 四问作答 + 可选子问题）。
 * @param options — 可选参数；`max_depth` 为 [0, MAX_DEPTH_LIMIT] 内的整数，缺省 3。
 * @returns 分类结论。
 */
export function classifyProblem(
  problem: CausalProblem,
  options?: ClassifyOptions,
): CausalClassification {
  const maxDepth = resolveMaxDepth(options);
  assertProblem(problem, 'problem');
  return classifyValidated(problem, maxDepth, 0);
}