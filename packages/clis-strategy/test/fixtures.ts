import type {
  ActionExecutor,
  ActionInvocation,
  ActionResult,
  CausalClassification,
  CausalType,
  CandidatePath,
  Evidence,
  JudgmentBasis,
  StrategyBoundary,
  SubModuleClassification,
} from '@clis/clis-contracts';

/**
 * 手搓的合法分类结论：只用来构造 strategy 的输入。
 * 真·端到端（真实分类器）放在 tests/ 由验证方覆盖。
 */
export function makeClassification(
  causalType: CausalType,
  extra: {
    confidence?: number;
    needs_exploration?: boolean;
    sub_modules?: readonly SubModuleClassification[];
  } = {},
): CausalClassification {
  const confidence = extra.confidence ?? 0.9;
  const evidence: Evidence[] = [
    {
      source: 'RULE',
      rule_id: 'fixture',
      statement: 'fixture：构造输入用',
      supports: causalType,
      weight: confidence,
    },
  ];
  const judgmentBasis: JudgmentBasis[] = [
    { rule_id: 'fixture', description: 'fixture', fired: true, effect: 'fixture' },
  ];

  const base = {
    causal_type: causalType,
    confidence,
    evidence,
    judgment_basis: judgmentBasis,
    needs_exploration: extra.needs_exploration ?? confidence < 0.7,
  };

  return extra.sub_modules === undefined ? base : { ...base, sub_modules: extra.sub_modules };
}

export function subModule(name: string, classification: CausalClassification): SubModuleClassification {
  return { name, classification };
}

export function boundary(
  forbidden: readonly string[] = [],
  allowed?: readonly string[],
): StrategyBoundary {
  return allowed === undefined
    ? { forbidden_actions: [...forbidden] }
    : { forbidden_actions: [...forbidden], allowed_actions: [...allowed] };
}

/** 记录调用序列的执行器替身：用"调用了几次、传了什么"做断言。 */
export function makeRecorder(
  handler: (invocation: ActionInvocation) => ActionResult = () => ({
    status: 'ok',
    detail: '执行器回执：完成',
  }),
): { executor: ActionExecutor; invocations: ActionInvocation[] } {
  const invocations: ActionInvocation[] = [];

  return {
    invocations,
    executor: {
      async execute(invocation: ActionInvocation): Promise<ActionResult> {
        invocations.push(invocation);
        return handler(invocation);
      },
    },
  };
}

/** 递归收集一棵路径树上出现的所有动作名。 */
export function allStepActions(paths: readonly CandidatePath[]): string[] {
  const actions: string[] = [];

  for (const path of paths) {
    for (const step of path.steps) actions.push(step.action);
    if (path.sub_paths !== undefined) actions.push(...allStepActions(path.sub_paths));
  }

  return actions;
}