/**
 * SPEC-feedback §5 输入校验 / §6 验证方第 6 项：四类错误码。
 *
 * 只构造单一故障（SPEC 未规定多故障时的错误码优先级）。
 */
import { describe, expect, it } from 'vitest';

import { ClisContractError } from '@clis/clis-contracts';
import type {
  ClisContractErrorCode,
  DetectOptions,
  FeedbackRequest,
} from '@clis/clis-contracts';
import * as feedbackPlugin from '@clis/clis-feedback';

import { captureContractError } from './helpers';
import {
  classificationRef,
  fbBoundary,
  makeResult,
  request,
  succeededResult,
} from './feedback-helpers';

const VALID_RESULT = succeededResult();
const VALID_CLASSIFICATION = classificationRef('cyclic');
const VALID_BOUNDARY = fbBoundary();

interface BadCase {
  readonly name: string;
  readonly request: unknown;
  readonly options?: unknown;
  readonly code: ClisContractErrorCode;
  /** 若给出：details 中至少一条 path 含该字段名。 */
  readonly fieldPath?: string;
}

const validRequest = (): FeedbackRequest => ({
  result: VALID_RESULT,
  classification: VALID_CLASSIFICATION,
  boundary: VALID_BOUNDARY,
});

const cases: readonly BadCase[] = [
  // —— INVALID_RESULT ——
  { name: 'request 为 null', request: null, code: 'INVALID_RESULT' },
  { name: 'request 为字符串', request: 'request', code: 'INVALID_RESULT' },
  { name: 'request 为数组', request: [], code: 'INVALID_RESULT' },
  {
    name: 'result 缺失',
    request: { classification: VALID_CLASSIFICATION, boundary: VALID_BOUNDARY },
    code: 'INVALID_RESULT',
    fieldPath: 'result',
  },
  {
    name: 'result 为数字',
    request: { result: 42, classification: VALID_CLASSIFICATION, boundary: VALID_BOUNDARY },
    code: 'INVALID_RESULT',
    fieldPath: 'result',
  },
  {
    name: 'result.signals 非数组',
    request: { ...validRequest(), result: { ...VALID_RESULT, signals: 'observed' } },
    code: 'INVALID_RESULT',
    fieldPath: 'signals',
  },
  {
    name: 'result.signals 为数字',
    request: { ...validRequest(), result: { ...VALID_RESULT, signals: 3 } },
    code: 'INVALID_RESULT',
    fieldPath: 'signals',
  },
  {
    name: 'result.status 非法（done）',
    request: { ...validRequest(), result: { ...VALID_RESULT, status: 'done' } },
    code: 'INVALID_RESULT',
    fieldPath: 'status',
  },
  {
    name: 'result.status 缺失',
    request: {
      ...validRequest(),
      result: { path_id: 'p1', signals: [], blocked_actions: [] },
    },
    code: 'INVALID_RESULT',
    fieldPath: 'status',
  },
  {
    name: 'result.status 为 null',
    request: { ...validRequest(), result: { ...VALID_RESULT, status: null } },
    code: 'INVALID_RESULT',
    fieldPath: 'status',
  },

  // —— INVALID_CLASSIFICATION ——
  {
    name: 'classification 缺失',
    request: { result: VALID_RESULT, boundary: VALID_BOUNDARY },
    code: 'INVALID_CLASSIFICATION',
    fieldPath: 'classification',
  },
  {
    name: 'classification 为数字',
    request: { result: VALID_RESULT, classification: 7, boundary: VALID_BOUNDARY },
    code: 'INVALID_CLASSIFICATION',
    fieldPath: 'classification',
  },
  {
    name: 'classification.causal_type 非法（circle）',
    request: {
      ...validRequest(),
      classification: { causal_type: 'circle', confidence: 0.9 },
    },
    code: 'INVALID_CLASSIFICATION',
    fieldPath: 'causal_type',
  },
  {
    name: 'classification.causal_type 为数字',
    request: { ...validRequest(), classification: { causal_type: 3, confidence: 0.9 } },
    code: 'INVALID_CLASSIFICATION',
    fieldPath: 'causal_type',
  },
  {
    name: 'classification.causal_type 缺失',
    request: { ...validRequest(), classification: { confidence: 0.9 } },
    code: 'INVALID_CLASSIFICATION',
    fieldPath: 'causal_type',
  },

  // —— INVALID_BOUNDARY ——
  {
    name: 'boundary 缺失',
    request: { result: VALID_RESULT, classification: VALID_CLASSIFICATION },
    code: 'INVALID_BOUNDARY',
    fieldPath: 'boundary',
  },
  {
    name: 'boundary 为 null',
    request: { ...validRequest(), boundary: null },
    code: 'INVALID_BOUNDARY',
    fieldPath: 'boundary',
  },
  {
    name: 'boundary.forbidden_actions 非数组',
    request: { ...validRequest(), boundary: { forbidden_actions: 'act' } },
    code: 'INVALID_BOUNDARY',
    fieldPath: 'forbidden_actions',
  },
  {
    name: 'boundary.forbidden_actions 缺失',
    request: { ...validRequest(), boundary: { max_rounds: 3 } },
    code: 'INVALID_BOUNDARY',
    fieldPath: 'forbidden_actions',
  },

  // —— INVALID_OPTIONS ——
  {
    name: 'options.history.previous_signals 非数组',
    request: validRequest(),
    options: { history: { previous_signals: 'ineffective' } },
    code: 'INVALID_OPTIONS',
    fieldPath: 'previous_signals',
  },
  {
    name: 'options.history.previous_signals 为数字',
    request: validRequest(),
    options: { history: { previous_signals: 2 } },
    code: 'INVALID_OPTIONS',
    fieldPath: 'previous_signals',
  },
  {
    name: 'previous_signals 含非法信号类型（ok）',
    request: validRequest(),
    options: { history: { previous_signals: ['ok'] } },
    code: 'INVALID_OPTIONS',
  },
  {
    name: 'previous_signals 含非法信号类型（数字）',
    request: validRequest(),
    options: { history: { previous_signals: [42] } },
    code: 'INVALID_OPTIONS',
  },
];

describe('SPEC §5 / §6-6 畸形输入错误码', () => {
  for (const badCase of cases) {
    it(`${badCase.name} ⇒ ${badCase.code}`, () => {
      const error = captureContractError(() =>
        feedbackPlugin.detectSignal(
          badCase.request as FeedbackRequest,
          badCase.options as DetectOptions | undefined,
        ),
      );

      expect(error).toBeInstanceOf(ClisContractError);
      expect(error.name).toBe('ClisContractError');
      expect(error.code).toBe(badCase.code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(Array.isArray(error.details)).toBe(true);
      for (const detail of error.details) {
        expect(typeof detail.path).toBe('string');
        expect(typeof detail.expected).toBe('string');
        expect(typeof detail.received).toBe('string');
      }
      if (badCase.fieldPath !== undefined && error.details.length > 0) {
        expect(error.details.map((detail) => detail.path).join(' | ')).toContain(badCase.fieldPath);
      }
    });
  }
});

describe('SPEC §5 合法输入不得误报', () => {
  it('result.signals 为空数组仍然合法（不抛错）', () => {
    const empty = makeResult({ status: 'succeeded', signals: [], blocked_actions: [] });
    const signal = feedbackPlugin.detectSignal(request(empty, 'cyclic'));
    expect(signal.reason.length).toBeGreaterThan(0);
    expect(signal.evidence.length).toBeGreaterThan(0);
  });

  it('boundary 只给必需字段（forbidden_actions）合法', () => {
    const signal = feedbackPlugin.detectSignal(
      request(succeededResult(), 'cyclic', { boundary: { forbidden_actions: [] } }),
    );
    expect(signal.signal_type).toBe('effective');
  });

  it('options 缺省、history 缺省、previous_signals 为空数组均合法', () => {
    const req = request(succeededResult(), 'cyclic');
    for (const options of [
      undefined,
      {},
      { history: {} },
      { history: { previous_signals: [] } },
      { history: { previous_signals: ['effective'], rollback_count: 1 } },
    ] as const) {
      const signal = feedbackPlugin.detectSignal(req, options as DetectOptions | undefined);
      expect(signal.signal_type).toBe('effective');
    }
  });

  it('causal_type 取 unknown 合法（只读回显）', () => {
    const signal = feedbackPlugin.detectSignal(request(succeededResult(), 'unknown'));
    expect(signal.assumed_type).toBe('unknown');
  });

  it('confidence 不做范围校验（SPEC §5 未列入畸形条件）', () => {
    const signal = feedbackPlugin.detectSignal(
      request(succeededResult(), 'cyclic', {
        classification: { causal_type: 'cyclic', confidence: 99 },
      }),
    );
    expect(signal.signal_type).toBe('effective');
    expect(signal.assumed_type).toBe('cyclic');
  });
});