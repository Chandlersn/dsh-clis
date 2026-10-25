import {
  ClisContractError,
  DEFAULT_MAX_DEPTH,
  FAMILY_BY_TYPE,
  MAX_DEPTH_LIMIT,
  PATH_VARIANTS,
  PROBE_FAMILY,
  blockedReason,
  isCausalType,
  scorePath,
} from '@clis/clis-contracts';
import type {
  BlockedAction,
  CandidatePath,
  CausalClassification,
  CausalType,
  ClisContractErrorDetail,
  PathScoreComponents,
  PathStep,
  PathVariantId,
  StrategyBoundary,
  StrategyFamily,
  StrategyMatchOptions,
} from '@clis/clis-contracts';

import { STRATEGY_LIBRARY, STRATEGY_LIBRARY_VERSION, libraryVariant } from './library';
import type { LibraryVariant } from './library';
import { assertBoundary, describeReceived, fail, isPlainObject } from './validation';

/** 低置信度时追加的探索变体。 */
const EXTRA_PROBE_VARIANT: PathVariantId = 'probe.minimal';

/** 追加到"已知类型"候选集里的探索路径，其类型匹配度被压到 0.5。 */
const EXTRA_PROBE_TYPE_FIT = 0.5;

/** 组装期的路径草稿；只有 path_id / rank / sub_paths 需要写，其余保持只读。 */
interface MutablePath {
  path_id: string;
  variant: PathVariantId;
  variant_version: string;
  library_version: string;
  family: StrategyFamily;
  causal_type: CausalType;
  steps: readonly PathStep[];
  blocked_actions: readonly BlockedAction[];
  executable: boolean;
  components: PathScoreComponents;
  score: number;
  rank: number;
  summary: string;
  sub_paths?: readonly CandidatePath[];
}

function assertClassification(
  value: unknown,
  path: string,
): asserts value is CausalClassification {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_CLASSIFICATION', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (!isCausalType(value.causal_type)) {
    details.push({
      path: `${path}.causal_type`,
      expected: 'CausalType',
      received: describeReceived(value.causal_type),
    });
  }

  if (typeof value.confidence !== 'number' || Number.isNaN(value.confidence)) {
    details.push({
      path: `${path}.confidence`,
      expected: 'number',
      received: describeReceived(value.confidence),
    });
  }

  if (typeof value.needs_exploration !== 'boolean') {
    details.push({
      path: `${path}.needs_exploration`,
      expected: 'boolean',
      received: describeReceived(value.needs_exploration),
    });
  }

  const subModules = value.sub_modules;
  if (subModules !== undefined) {
    if (!Array.isArray(subModules)) {
      details.push({
        path: `${path}.sub_modules`,
        expected: 'array | undefined',
        received: describeReceived(subModules),
      });
    } else {
      subModules.forEach((sub, index) => {
        if (!isPlainObject(sub)) {
          details.push({
            path: `${path}.sub_modules[${index}]`,
            expected: 'object',
            received: describeReceived(sub),
          });
          return;
        }
        if (typeof sub.name !== 'string' || sub.name.length === 0) {
          details.push({
            path: `${path}.sub_modules[${index}].name`,
            expected: 'non-empty string',
            received: describeReceived(sub.name),
          });
        }
        if (!isPlainObject(sub.classification)) {
          details.push({
            path: `${path}.sub_modules[${index}].classification`,
            expected: 'object',
            received: describeReceived(sub.classification),
          });
          return;
        }
        try {
          assertClassification(sub.classification, `${path}.sub_modules[${index}].classification`);
        } catch (error) {
          if (error instanceof ClisContractError) details.push(...error.details);
          else throw error;
        }
      });
    }
  }

  if (details.length > 0) fail('INVALID_CLASSIFICATION', `${path} 不是合法的分类结论`, details);
}

function resolveMaxDepth(options: StrategyMatchOptions | undefined): number {
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

/** 按边界剔步：被阻断的动作不进 steps，只记一条 blocked_actions。 */
function buildSteps(
  variant: LibraryVariant,
  boundary: StrategyBoundary,
): { steps: PathStep[]; blocked: BlockedAction[] } {
  const steps: PathStep[] = [];
  const blocked: BlockedAction[] = [];
  const seen = new Set<string>();

  for (const spec of variant.steps) {
    const reason = blockedReason(spec.action, boundary);
    if (reason !== null) {
      if (!seen.has(spec.action)) {
        seen.add(spec.action);
        blocked.push({ action: spec.action, reason });
      }
      continue;
    }

    steps.push({
      index: steps.length,
      action: spec.action,
      params: spec.params,
      rationale: spec.rationale,
    });
  }

  return { steps, blocked };
}

/** 按 `<父 id>.<k>` 重写整棵子树的 path_id。 */
function rebasePathIds(path: CandidatePath, pathId: string): CandidatePath {
  const next: MutablePath = { ...path, path_id: pathId };
  if (path.sub_paths !== undefined) {
    next.sub_paths = path.sub_paths.map((sub, index) =>
      rebasePathIds(sub, `${pathId}.${index + 1}`),
    );
  }
  return next;
}

function buildPath(
  variant: LibraryVariant,
  pathId: string,
  classification: CausalClassification,
  boundary: StrategyBoundary,
  maxDepth: number,
  depth: number,
): CandidatePath {
  const built = buildSteps(variant, boundary);
  const subModules = classification.sub_modules ?? [];

  // decompose 的切分数来自实际子模块数量，不由库里写死。
  const steps =
    variant.family === 'decompose'
      ? built.steps.map((step) =>
          step.action === 'partition_sub_modules'
            ? { ...step, params: { count: subModules.length } }
            : step,
        )
      : built.steps;
  const blocked = built.blocked;

  const components = variant.components;
  const draft: MutablePath = {
    path_id: pathId,
    variant: variant.variant,
    variant_version: variant.variant_version,
    library_version: STRATEGY_LIBRARY_VERSION,
    family: variant.family,
    causal_type: classification.causal_type,
    steps,
    blocked_actions: blocked,
    executable: blocked.length === 0,
    components,
    score: scorePath(components),
    rank: 0,
    summary: variant.summary,
  };

  if (variant.family === 'decompose' && subModules.length > 0 && depth + 1 <= maxDepth) {
    const subPaths: CandidatePath[] = [];
    subModules.forEach((sub, index) => {
      const candidates = matchAtDepth(sub.classification, boundary, maxDepth, depth + 1);
      // 取可执行者中名次最好的那条；若全都不可执行，退化为 rank 1（执行时会被判 blocked）。
      const chosen = candidates.find((candidate) => candidate.executable) ?? candidates[0];
      if (chosen !== undefined) subPaths.push(rebasePathIds(chosen, `${pathId}.${index + 1}`));
    });

    // 兄弟子路径在**同一层**内重排名次：rank 的定义是"同级名次，从 1 起连续"，
    // 每条子路径在它自己的候选集里都是 rank 1，直接沿用会得出两个 rank=1。
    if (subPaths.length > 0) {
      draft.sub_paths = [...subPaths]
        .sort((left, right) => right.score - left.score)
        .map((path, index) => ({ ...path, rank: index + 1 }));
    }
  }

  return draft;
}

function matchAtDepth(
  classification: CausalClassification,
  boundary: StrategyBoundary,
  maxDepth: number,
  depth: number,
): CandidatePath[] {
  const family: StrategyFamily =
    classification.causal_type === 'unknown'
      ? PROBE_FAMILY
      : FAMILY_BY_TYPE[classification.causal_type];

  const variants: LibraryVariant[] = STRATEGY_LIBRARY.filter(
    (entry) => entry.family === family,
  );

  const subModules = classification.sub_modules ?? [];
  const wantsExtraProbe =
    (classification.needs_exploration && classification.causal_type !== 'unknown') ||
    (classification.causal_type === 'nested' && subModules.length === 0);

  if (wantsExtraProbe && !variants.some((entry) => entry.variant === EXTRA_PROBE_VARIANT)) {
    const probe = libraryVariant(EXTRA_PROBE_VARIANT);
    if (probe !== undefined) {
      variants.push({
        ...probe,
        components: { ...probe.components, type_fit: EXTRA_PROBE_TYPE_FIT },
      });
    }
  }

  // path_id 与分数无关：一律按 PATH_VARIANTS 的声明顺序编号，保证可复现。
  const canonical = [...variants].sort(
    (left, right) => PATH_VARIANTS.indexOf(left.variant) - PATH_VARIANTS.indexOf(right.variant),
  );

  const built = canonical.map((variant, index) =>
    buildPath(variant, `p${index + 1}`, classification, boundary, maxDepth, depth),
  );

  // Array.prototype.sort 自 ES2019 起稳定：同分者保持上面的声明顺序。
  return [...built]
    .sort((left, right) => right.score - left.score)
    .map((path, index) => ({ ...path, rank: index + 1 }));
}

/**
 * 依据分类结论匹配策略、生成候选路径并排序 —— 纯函数：同步、确定性、无 I/O。
 *
 * 不重新判断因果类型；`boundary.forbidden_actions` 内的动作绝不出现在返回路径的
 * `steps` 中（被剔除的动作记录在 `blocked_actions` 里）。
 *
 * @param classification — 来自 clis-classifier 的结论。
 * @param boundary — 策略边界。
 * @param options — 可选参数；`max_depth` 为 [0, MAX_DEPTH_LIMIT] 内的整数，缺省 3。
 * @returns 按 score 降序、名次从 1 起的候选路径；至少 1 条。
 */
export function matchPaths(
  classification: CausalClassification,
  boundary: StrategyBoundary,
  options?: StrategyMatchOptions,
): readonly CandidatePath[] {
  const maxDepth = resolveMaxDepth(options);
  assertClassification(classification, 'classification');
  assertBoundary(boundary, 'boundary');
  return matchAtDepth(classification, boundary, maxDepth, 0);
}