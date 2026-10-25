import { ClisContractError } from '@clis/clis-contracts';
import type {
  CandidatePath,
  ClisContractErrorCode,
  ClisContractErrorDetail,
  ExecutePathOptions,
  PathStep,
  StrategyBoundary,
} from '@clis/clis-contracts';

/**
 * 校验工具的唯一实现。
 * 两个文件各写一份校验逻辑，迟早会出现"一边收紧一边放松"的分歧。
 */

export function fail(
  code: ClisContractErrorCode,
  message: string,
  details: readonly ClisContractErrorDetail[],
): never {
  throw new ClisContractError(code, message, details);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeReceived(value: unknown): string {
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

export function assertBoundary(value: unknown, path: string): asserts value is StrategyBoundary {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_BOUNDARY', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  const forbidden = value.forbidden_actions;
  if (!Array.isArray(forbidden)) {
    details.push({
      path: `${path}.forbidden_actions`,
      expected: 'string[]',
      received: describeReceived(forbidden),
    });
  } else {
    forbidden.forEach((action, index) => {
      if (typeof action !== 'string') {
        details.push({
          path: `${path}.forbidden_actions[${index}]`,
          expected: 'string',
          received: describeReceived(action),
        });
      }
    });
  }

  const allowed = value.allowed_actions;
  if (allowed !== undefined) {
    if (!Array.isArray(allowed)) {
      details.push({
        path: `${path}.allowed_actions`,
        expected: 'string[] | undefined',
        received: describeReceived(allowed),
      });
    } else {
      allowed.forEach((action, index) => {
        if (typeof action !== 'string') {
          details.push({
            path: `${path}.allowed_actions[${index}]`,
            expected: 'string',
            received: describeReceived(action),
          });
        }
      });
    }
  }

  if (details.length > 0) fail('INVALID_BOUNDARY', `${path} 不是合法的策略边界`, details);
}

function assertStep(value: unknown, path: string): asserts value is PathStep {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_PATH', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (!Number.isInteger(value.index) || (value.index as number) < 0) {
    details.push({
      path: `${path}.index`,
      expected: 'non-negative integer',
      received: describeReceived(value.index),
    });
  }
  if (typeof value.action !== 'string' || value.action.length === 0) {
    details.push({
      path: `${path}.action`,
      expected: 'non-empty string',
      received: describeReceived(value.action),
    });
  }
  if (!isPlainObject(value.params)) {
    details.push({
      path: `${path}.params`,
      expected: 'object',
      received: describeReceived(value.params),
    });
  }
  if (typeof value.rationale !== 'string' || value.rationale.length === 0) {
    details.push({
      path: `${path}.rationale`,
      expected: 'non-empty string',
      received: describeReceived(value.rationale),
    });
  }

  if (details.length > 0) fail('INVALID_PATH', `${path} 不是合法的路径步骤`, details);
}

/** 校验一条候选路径。执行器是"只吃数据"的，所以路径必须自己站得住。 */
export function assertPath(value: unknown, path: string): asserts value is CandidatePath {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_PATH', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (typeof value.path_id !== 'string' || value.path_id.length === 0) {
    details.push({
      path: `${path}.path_id`,
      expected: 'non-empty string',
      received: describeReceived(value.path_id),
    });
  }

  if (!Array.isArray(value.steps)) {
    fail('INVALID_PATH', `${path}.steps 必须是数组`, [
      {
        path: `${path}.steps`,
        expected: 'array',
        received: describeReceived(value.steps),
      },
    ]);
  }

  value.steps.forEach((step, index) => {
    if (!isPlainObject(step)) {
      details.push({
        path: `${path}.steps[${index}]`,
        expected: 'object',
        received: describeReceived(step),
      });
      return;
    }
    try {
      assertStep(step, `${path}.steps[${index}]`);
    } catch (error) {
      if (error instanceof ClisContractError) details.push(...error.details);
      else throw error;
    }
  });

  const subPaths = value.sub_paths;
  if (subPaths !== undefined) {
    if (!Array.isArray(subPaths)) {
      details.push({
        path: `${path}.sub_paths`,
        expected: 'array | undefined',
        received: describeReceived(subPaths),
      });
    } else {
      subPaths.forEach((sub, index) => {
        try {
          assertPath(sub, `${path}.sub_paths[${index}]`);
        } catch (error) {
          if (error instanceof ClisContractError) details.push(...error.details);
          else throw error;
        }
      });
    }
  }

  if (details.length > 0) fail('INVALID_PATH', `${path} 不是合法的候选路径`, details);
}

/** 校验 execute 的依赖：边界与执行器都不可省。 */
export function assertExecuteOptions(
  value: unknown,
  path: string,
): asserts value is ExecutePathOptions {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_OPTIONS', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  try {
    assertBoundary(value.boundary, `${path}.boundary`);
  } catch (error) {
    if (error instanceof ClisContractError) details.push(...error.details);
    else throw error;
  }

  const executor = value.executor;
  if (!isPlainObject(executor) || typeof executor.execute !== 'function') {
    details.push({
      path: `${path}.executor`,
      expected: 'object with execute()',
      received: describeReceived(executor),
    });
  }

  if (details.length > 0) fail('INVALID_OPTIONS', `${path} 缺少可用的边界或执行器`, details);
}