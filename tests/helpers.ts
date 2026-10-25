/**
 * 独立黑盒验收套件的共享工具。
 *
 * 纪律：本文件的一切期望值只来自 `docs/SPEC-classifier.md`（冻结规格）与
 * `@clis/clis-contracts`（共享契约），绝不从 `packages/clis-classifier/src/**`
 * 的实现反推。（唯一例外：`classifier-responsibility.test.ts` 的静态检查按
 * SPEC §6 第 12 项读取源码文本做断言。）
 */
import { expect } from 'vitest';

import {
  CAUSAL_TYPES,
  CONFIDENCE_CEILING,
  EXPLORATION_THRESHOLD,
  KNOWN_CAUSAL_TYPES,
} from '@clis/clis-contracts';
import { ClisContractError } from '@clis/clis-contracts';
import type {
  CausalClassification,
  CausalProblem,
  CausalType,
  Evidence,
  FourAnswers,
  JudgmentBasis,
  TriState,
} from '@clis/clis-contracts';

/** SPEC §4：判据规则表 R1–R11，`judgment_basis` 必须每条各一项。 */
export const RULE_IDS: readonly string[] = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
];

/** SPEC §5 允许的证据来源（契约 `EvidenceSource`）。 */
export const EVIDENCE_SOURCES: readonly string[] = [
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'DESCRIPTION',
  'SUBMODULE',
  'RULE',
];

/** 契约 `KNOWN_CAUSAL_TYPES` 的固定顺序，SPEC §4.2 要求同分时保持它。 */
export const KNOWN_ORDER: readonly string[] = KNOWN_CAUSAL_TYPES;

/** 构造四问作答。字段名取自契约 `FourAnswers`。 */
export function answer4(
  q1: TriState,
  q2: TriState,
  q3: TriState,
  q4: TriState,
): FourAnswers {
  return {
    q1_simultaneous_mutual_definition: q1,
    q2_delayed_mutual_influence: q2,
    q3_strict_irreversible_order: q3,
    q4_coexisting_causal_structures: q4,
  };
}

export interface ProblemExtra {
  readonly description?: string;
  readonly sub_problems?: readonly CausalProblem[];
  readonly label?: string;
}

/** 构造一个合法 problem；缺省 description 为空串（SPEC §3 允许空串）。 */
export function makeProblem(
  q1: TriState,
  q2: TriState,
  q3: TriState,
  q4: TriState,
  extra: ProblemExtra = {},
): CausalProblem {
  const problem: {
    description: string;
    answers: FourAnswers;
    sub_problems?: readonly CausalProblem[];
    label?: string;
  } = {
    description: extra.description ?? '',
    answers: answer4(q1, q2, q3, q4),
  };
  if (extra.sub_problems !== undefined) problem.sub_problems = extra.sub_problems;
  if (extra.label !== undefined) problem.label = extra.label;
  return problem;
}

/** SPEC §4.1 的独立判据预言机：类型、置信度、探索模式全部由规则表算出。 */
export interface ExpectedOutcome {
  readonly causal_type: CausalType;
  readonly confidence: number;
  readonly unknownCount: number;
  readonly r3: boolean;
  readonly r4: boolean;
}

const R2_TYPES = ['structural_duality', 'cyclic', 'unidirectional'] as const;

/**
 * 由 SPEC §4 规则表 + §4.1 数值表独立推导的期望。
 *
 * - R1：Q4 === 'yes' ⇒ nested
 * - R2：Q4 !== 'yes' 且 d === 1 ⇒ 该唯一 yes 对应的类型
 * - R3：Q4 !== 'yes' 且 d >= 2 ⇒ nested，置信度再扣 0.15
 * - R4：d === 0 且 Q4 !== 'yes' ⇒ unknown，置信度由 §4.1 表定为 0.4 / 0.25
 */
export function expectedOutcome(
  q1: TriState,
  q2: TriState,
  q3: TriState,
  q4: TriState,
): ExpectedOutcome {
  const answers: readonly TriState[] = [q1, q2, q3];
  const yesIndexes = answers
    .map((state, index) => (state === 'yes' ? index : -1))
    .filter((index) => index >= 0);
  const d = yesIndexes.length;
  const unknownCount = [q1, q2, q3, q4].filter((state) => state === 'unknown').length;
  const r3 = q4 !== 'yes' && d >= 2;
  const r4 = d === 0 && q4 !== 'yes';

  let causalType: CausalType;
  if (q4 === 'yes') {
    causalType = 'nested';
  } else if (d === 1) {
    causalType = R2_TYPES[yesIndexes[0] as number] as CausalType;
  } else if (d >= 2) {
    causalType = 'nested';
  } else {
    causalType = 'unknown';
  }

  let confidence: number;
  if (r4) {
    // §4.1 表：四问全 no ⇒ 0.4；含至少一个 unknown ⇒ 0.25。
    confidence = unknownCount === 0 ? 0.4 : 0.25;
  } else {
    const raw = 0.9 - 0.08 * unknownCount - (r3 ? 0.15 : 0);
    confidence = Math.round(Math.min(raw, CONFIDENCE_CEILING) * 100) / 100;
  }

  return { causal_type: causalType, confidence, unknownCount, r3, r4 };
}

/** 取某条判据轨迹；缺失即抛错（SPEC §4：R1–R11 全部出现）。 */
export function ruleTrace(result: CausalClassification, ruleId: string): JudgmentBasis {
  const found = result.judgment_basis.find((basis) => basis.rule_id === ruleId);
  if (!found) throw new Error(`judgment_basis 缺少规则 ${ruleId}`);
  return found;
}

/** SPEC §5：末尾恒有一条 RULE 来源的"主判据"证据，weight === 最终 confidence。 */
export function mainRuleEvidence(result: CausalClassification): Evidence {
  const evidence = result.evidence;
  expect(evidence.length).toBeGreaterThan(0);
  return evidence[evidence.length - 1] as Evidence;
}

/** 断言主判据证据指出所触发的主规则（statement 含该规则号）。 */
export function expectMainRuleEvidence(result: CausalClassification, ruleId: string): void {
  const last = mainRuleEvidence(result);
  expect(last.source).toBe('RULE');
  expect(last.weight).toBe(result.confidence);
  expect(last.statement).toContain(ruleId);
}

/**
 * SPEC §5 证据不变量的违规清单（返回字符串而非直接断言，便于全矩阵汇总）。
 */
export function evidenceViolations(result: CausalClassification, label: string): string[] {
  const bad: string[] = [];
  const evidence = result.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    bad.push(`${label}: evidence 必须恒为非空数组`);
    return bad;
  }
  evidence.forEach((item, index) => {
    if (typeof item.statement !== 'string' || item.statement.length === 0) {
      bad.push(`${label}: evidence[${index}].statement 必须是非空字符串`);
    }
    if (typeof item.rule_id !== 'string' || item.rule_id.length === 0) {
      bad.push(`${label}: evidence[${index}].rule_id 必须是非空字符串`);
    }
    if (!Number.isFinite(item.weight) || item.weight < 0 || item.weight > 1) {
      bad.push(`${label}: evidence[${index}].weight 必须在 [0,1] 内，实际 ${String(item.weight)}`);
    }
    if (!EVIDENCE_SOURCES.includes(item.source)) {
      bad.push(`${label}: evidence[${index}].source 非法：${String(item.source)}`);
    }
    if (!(CAUSAL_TYPES as readonly string[]).includes(item.supports)) {
      bad.push(`${label}: evidence[${index}].supports 非法：${String(item.supports)}`);
    }
  });

  const last = evidence[evidence.length - 1] as Evidence;
  if (last.source !== 'RULE') {
    bad.push(`${label}: 末尾证据 source 必须为 RULE，实际 ${String(last.source)}`);
  }
  if (last.weight !== result.confidence) {
    bad.push(`${label}: 末尾主判据 weight(${last.weight}) 必须等于 confidence(${result.confidence})`);
  }
  return bad;
}

export function expectEvidenceSound(result: CausalClassification, label = ''): void {
  expect(evidenceViolations(result, label)).toStrictEqual([]);
}

/**
 * SPEC §4/§4.2/§4.3/§5/§6 的跨字段不变量违规清单。
 */
export function invariantViolations(result: CausalClassification, label: string): string[] {
  const bad: string[] = [];
  const confidence = result.confidence;

  if (!Number.isFinite(confidence) || !(confidence > 0) || confidence > CONFIDENCE_CEILING) {
    bad.push(`${label}: confidence 必须 ∈ (0, ${CONFIDENCE_CEILING}]，实际 ${String(confidence)}`);
  }
  if (confidence === 1) {
    bad.push(`${label}: confidence 绝不允许等于 1.0`);
  }
  if (result.needs_exploration !== confidence < EXPLORATION_THRESHOLD) {
    bad.push(
      `${label}: needs_exploration 必须等于 (confidence < ${EXPLORATION_THRESHOLD})，confidence=${confidence}`,
    );
  }
  if (result.needs_exploration) {
    if (
      typeof result.exploration_reason !== 'string' ||
      result.exploration_reason.length === 0
    ) {
      bad.push(`${label}: needs_exploration=true 时 exploration_reason 必须存在且非空`);
    }
  } else if (result.exploration_reason !== undefined) {
    bad.push(`${label}: needs_exploration=false 时 exploration_reason 必须不存在`);
  }

  const isUnknown = result.causal_type === 'unknown';
  if (isUnknown !== (result.candidate_hypotheses !== undefined)) {
    bad.push(`${label}: candidate_hypotheses 仅应在 causal_type==='unknown' 时存在`);
  }
  if (isUnknown) {
    const candidates = result.candidate_hypotheses ?? [];
    if (candidates.length !== KNOWN_ORDER.length) {
      bad.push(
        `${label}: candidate_hypotheses 必须覆盖四类已知类型，实际 ${candidates.length} 项`,
      );
    }
    const types = candidates.map((candidate) => candidate.causal_type);
    if (types.join('|') !== KNOWN_ORDER.join('|')) {
      bad.push(
        `${label}: candidate_hypotheses 同分时必须保持 KNOWN_CAUSAL_TYPES 顺序，实际 ${types.join('|')}`,
      );
    }
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1] as { confidence: number };
      const current = candidates[index] as { confidence: number };
      if (previous.confidence < current.confidence) {
        bad.push(`${label}: candidate_hypotheses 必须按置信度降序`);
        break;
      }
    }
    for (const candidate of candidates) {
      if (typeof candidate.rationale !== 'string' || candidate.rationale.length === 0) {
        bad.push(`${label}: candidate_hypotheses[].rationale 必须非空`);
      }
      if (
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence <= 0 ||
        candidate.confidence > CONFIDENCE_CEILING
      ) {
        bad.push(
          `${label}: candidate_hypotheses[].confidence 必须 ∈ (0, ${CONFIDENCE_CEILING}]，实际 ${String(candidate.confidence)}`,
        );
      }
    }
  }

  const isNested = result.causal_type === 'nested';
  if (isNested !== (result.sub_modules !== undefined)) {
    bad.push(`${label}: sub_modules 仅应在 causal_type==='nested' 时存在`);
  }
  if (result.sub_modules !== undefined && !Array.isArray(result.sub_modules)) {
    bad.push(`${label}: sub_modules 必须是数组`);
  }

  const basis = result.judgment_basis;
  const ids = basis.map((item) => item.rule_id);
  if (ids.length !== RULE_IDS.length || new Set(ids).size !== RULE_IDS.length) {
    bad.push(`${label}: judgment_basis 必须 R1–R11 各一项（共 ${RULE_IDS.length} 项），实际 ${ids.length}`);
  }
  for (const ruleId of RULE_IDS) {
    if (!ids.includes(ruleId)) bad.push(`${label}: judgment_basis 缺少 ${ruleId}`);
  }
  for (const item of basis) {
    if (typeof item.description !== 'string') {
      bad.push(`${label}: judgment_basis[${item.rule_id}].description 必须是字符串`);
    }
    if (typeof item.fired !== 'boolean') {
      bad.push(`${label}: judgment_basis[${item.rule_id}].fired 必须是布尔值`);
    }
    if (item.fired && (typeof item.effect !== 'string' || item.effect.length === 0)) {
      bad.push(`${label}: judgment_basis[${item.rule_id}] 已触发但缺少非空 effect`);
    }
  }

  bad.push(...evidenceViolations(result, label));
  return bad;
}

export function expectInvariants(result: CausalClassification, label = ''): void {
  expect(invariantViolations(result, label)).toStrictEqual([]);
}

/** 捕获一次同步调用抛出的 ClisContractError；不是它或没抛都算调用方失败。 */
export function captureContractError(run: () => unknown): ClisContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ClisContractError) return error;
    throw new Error(`期望抛 ClisContractError，实际抛出 ${String(error)}`);
  }
  throw new Error('期望抛 ClisContractError，但没有任何异常抛出');
}