import { blockedReason } from '@clis/clis-contracts';
import type {
  BlockedAction,
  BlockedActionReason,
  CandidatePath,
  ExecutePathOptions,
  ExecutionResult,
  ExecutionSignal,
  ExecutionSignalKind,
  ExecutionStatus,
} from '@clis/clis-contracts';

import { assertExecuteOptions, assertPath } from './validation';

function signal(
  pathId: string,
  stepIndex: number,
  action: string,
  kind: ExecutionSignalKind,
  detail: string,
): ExecutionSignal {
  return { path_id: pathId, step_index: stepIndex, action, kind, detail };
}

function describeReason(reason: BlockedActionReason): string {
  return reason === 'forbidden' ? '在 forbidden_actions 中' : '不在 allowed_actions 白名单内';
}

function summarySignal(pathId: string, detail: string): ExecutionSignal {
  return signal(pathId, -1, 'summary', 'summary', detail);
}

/**
 * 执行一条候选路径。
 *
 * 绝不把边界阻断的动作交给执行器 —— 即使这条路径是调用方手搓的、绕过生成阶段塞进来的。
 * **不自行决定回退**：只回执 status 与 signals，回退由 orchestrator 决定。
 *
 * @param path — 要执行的路径。
 * @param options — 边界与执行器。
 * @returns 执行结论；路径或依赖畸形时抛 ClisContractError。
 */
export async function executePath(
  path: CandidatePath,
  options: ExecutePathOptions,
): Promise<ExecutionResult> {
  assertPath(path, 'path');
  assertExecuteOptions(options, 'options');

  const { boundary, executor } = options;
  const pathId = path.path_id;

  // —— 预检：路径是数据，执行前再挡一次 ——
  // 两种"被阻断"都算：① 生成阶段就声明剔除过动作（executable=false / blocked_actions 非空）；
  // ② 调用方手搓的路径在运行时命中边界。任一情况都整条不执行 ——
  // 缺步的因果链比不执行更危险（例如没定位反馈环就直接去干预杠杆点）。
  const precheck: BlockedAction[] = [...path.blocked_actions];
  const reasonByAction = new Map<string, BlockedActionReason>();
  for (const item of precheck) reasonByAction.set(item.action, item.reason);

  for (const step of path.steps) {
    const reason = blockedReason(step.action, boundary);
    if (reason === null || reasonByAction.has(step.action)) continue;
    reasonByAction.set(step.action, reason);
    precheck.push({ action: step.action, reason });
  }

  const declaredNotExecutable = path.executable === false;

  if (precheck.length > 0 || declaredNotExecutable) {
    // 宁可整条不做，也不做半截。
    const signals: ExecutionSignal[] = path.steps.map((step) => {
      const reason = reasonByAction.get(step.action);
      return reason === undefined
        ? signal(
            pathId,
            step.index,
            step.action,
            'not_attempted',
            '本路径已被边界阻断，未执行任何步骤',
          )
        : signal(
            pathId,
            step.index,
            step.action,
            'skipped_forbidden',
            `动作 ${step.action} 被边界阻断（${describeReason(reason)}），未交给执行器`,
          );
    });
    signals.push(
      summarySignal(
        pathId,
        declaredNotExecutable
          ? `路径声明为不可执行（生成阶段已剔除 ${precheck.length} 个动作），整条未执行`
          : `边界阻断 ${precheck.length} 个动作，整条未执行`,
      ),
    );
    return { path_id: pathId, status: 'blocked', signals, blocked_actions: precheck };
  }

  // —— 依序执行自身步骤 ——
  const signals: ExecutionSignal[] = [];
  let selfFailed = false;

  for (const step of path.steps) {
    if (selfFailed) {
      signals.push(signal(pathId, step.index, step.action, 'not_attempted', '前序步骤失败，未执行'));
      continue;
    }

    const result = await executor.execute({
      path_id: pathId,
      step_index: step.index,
      action: step.action,
      params: step.params,
    });

    if (result.status === 'ok') {
      signals.push(signal(pathId, step.index, step.action, 'observed', result.detail));
    } else {
      signals.push(signal(pathId, step.index, step.action, 'failed', result.detail));
      selfFailed = true;
    }
  }

  // —— decompose：自身没问题才轮到子路径 ——
  const subPaths = path.sub_paths ?? [];
  const subResults: ExecutionResult[] = [];
  let status: ExecutionStatus;

  if (selfFailed) {
    status = 'failed';
  } else if (subPaths.length > 0) {
    for (const sub of subPaths) subResults.push(await executePath(sub, options));

    if (subResults.some((item) => item.status === 'failed')) status = 'failed';
    else if (subResults.some((item) => item.status === 'blocked')) status = 'blocked';
    else status = 'succeeded';
  } else {
    status = 'succeeded';
  }

  const subSummary =
    subResults.length === 0
      ? ''
      : `；子路径 ${subResults.length} 条（${subResults.map((item) => item.status).join('/')}）`;
  signals.push(summarySignal(pathId, `${path.steps.length} 步，状态 ${status}${subSummary}`));

  const draft: {
    path_id: string;
    status: ExecutionStatus;
    signals: ExecutionSignal[];
    blocked_actions: BlockedAction[];
    sub_results?: ExecutionResult[];
  } = { path_id: pathId, status, signals, blocked_actions: [] };

  if (subResults.length > 0) draft.sub_results = subResults;

  return draft;
}