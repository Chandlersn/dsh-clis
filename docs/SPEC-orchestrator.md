# 冻结规格 · clis-orchestrator

> 状态：**FROZEN**（Lead 定稿，2026-10-25）。实现者与验证者都以本文件为准。

## 1. 边界（硬约束）

clis-orchestrator **只做编排与决策**。禁止：

- 写任何因果判断规则（不得 import classifier 实现，不得出现四问符号）。
- 写任何策略匹配规则（不得 import strategy 实现）。
- 写任何反馈检测规则（不得 import feedback 实现）。
- 重新执行策略或自行执行动作（执行器由调用方提供，orchestrator 只透传）。
- `import` 任何其它 CLIS 插件的实现文件 —— 只依赖 `@clis/clis-contracts`。

它通过 **inject 三个服务名**（classifier / strategy / feedback）来"调用"，绝不 import 其实现。

## 2. 公开面（逐字匹配）

| 导出 | 形状 |
| --- | --- |
| `name` | `'clis-orchestrator'` |
| `inject` | `['clis.causalClassifier','clis.causalStrategy','clis.causalFeedback']` |
| `apply` | `(ctx: Context) => void` |
| `OrchestratorServiceImpl` | `class extends Service implements OrchestratorService` |
| `decide` | `(round, state, options?) => { decision, nextState }`，**纯函数**：同步、确定性、无 I/O |
| `run` | `(problem, options?) => Promise<OrchestratorRunResult>`，自动闭环循环 |
| `runRound` | 跑单轮，供调用方自行控轮 |
| `ROLLBACK_LIMIT_DEFAULT` | `3` |
| `TYPE_LOCK_ROUNDS_DEFAULT` | `1` |

服务名：`CAUSAL_ORCHESTRATOR_SERVICE`（值 `'clis.causalOrchestrator'`）。

## 2.1 `run(problem)` 的闭环语义

自动循环，直到终局：

| 信号 | 动作 | 循环内行为 |
| --- | --- | --- |
| `effective` | `continue` | **返回** `outcome='effective'` |
| `ineffective` | `switch_path` | 换下一条候选路径；**路径用尽时**退回重新分类（`rollback_count+1`），不直接判死 |
| `type_misjudged` | `rollback_to_classifier` | 重新 `classify` + 重新 `match`，`rollback_count+1` |
| `boundary_invalid` | `rollback_to_boundary` | 重新 `match`，`rollback_count+1` |
| 锁定中 | `lock_and_continue` | **返回** `outcome='effective'`（锁定期内按当前类型继续推进） |
| 回退耗尽 | `manual_intervention` | **返回** `outcome='manual_intervention'` |

- `outcome` 取值：`'effective' | 'manual_intervention' | 'exhausted'`。
- `max_rounds`（缺省 32）是防失控保护；触顶返回 `manual_intervention`。
- 返回的 `state.traces` 恒完整（每轮一条，永不丢弃）。

> 注：`lock_and_continue` 之所以算 `effective` 终局，是因为它表示"本轮不再回退、按当前类型继续推进"，
> 而不是"结果已验证有效"。调用方若需区分，读 `decision.action`。

## 3. 决策优先级（自上而下，命中即返回）

输入：`round.signal.signal_type`、`round.execution.status`、`round.causal_type`、`state`、`options`。

### 3.1 `manual_intervention`（最高优先级）

条件：`state.rollback_count >= rollback_limit`（缺省 3）**且**本轮信号仍为
`type_misjudged` / `ineffective` / `boundary_invalid`（即仍未解决）。

- 输出 `action='manual_intervention'`，`reason` 必须含"需人工介入"字样。
- 此时 `nextState.traces` 仍要追加本轮 trace（**完整 trace 是硬要求**）。
- `rollback_count` 不增。

> **重要：两条硬约束会相互作用（2026-10-25 实现时发现）。**
> 若把 §6 的"连续 3 次 `type_misjudged` ⇒ 第 4 次人工介入"理解成"连续 4 轮都回退"，
> 那是**不可达的** —— 因为 §3.4 规定同一类型连续回退 2 次即触发震荡锁定，第 3 轮必然变成
> `lock_and_continue`（不回退、`rollback_count` 不增）。两者叠加后的真实序列是：
>
> | 轮次 | 1 | 2 | 3 | 4 | 5 |
> | --- | --- | --- | --- | --- | --- |
> | 动作 | 回退 | 回退+锁定 | **锁定继续** | 回退 | **人工介入** |
> | rollback_count | 1 | 2 | 2 | 3 | 3 |
>
> 即：锁定抑制"同一类型的反复回退"，上限兜住"总回退次数"，二者叠加后达到上限需要 5 轮而非 4 轮。
> **验收必须按上表断言**，不得按"4 轮连续回退"断言。

### 3.2 锁定生效（震荡保护）

条件：`state.oscillation.lock_remaining > 0` 且本轮信号**不是** `effective`。

- 输出 `action='lock_and_continue'`，`locked_type = state.oscillation.locked_type`。
- `nextState.oscillation.lock_remaining = 上一轮 - 1`。
- **锁定期间不允许回退**：`rollback_count` 不变。

### 3.3 `rollback_to_boundary`

条件：`signal_type === 'boundary_invalid'`。

- `rollback_count + 1`。
- 输出 `action='rollback_to_boundary'`。

### 3.4 `rollback_to_classifier`

条件：`signal_type === 'type_misjudged'`。

- `rollback_count + 1`。
- `retry_type = signal.suggested_rollback?.target_type`（缺失时**不设**该字段）。
- **震荡记录**：对 `round.causal_type` 的 `consecutive_rollbacks` 计数 +1；若该计数 **≥2**
  （即同一类型连续被回退两次），则 `nextState.oscillation.locked_type = round.causal_type`、
  `lock_remaining = lock_rounds`（缺省 1）。
  - 该类型若被锁定，**本次仍按 rollback 执行**（锁定从下一轮生效）。

### 3.5 `switch_path`

条件：`signal_type === 'ineffective'` **且**本轮路径可换（调用方在 `round` 里给出的
`next_path_id` 存在时用它；否则 `next_path_id` 不设，仍输出 `switch_path`）。

### 3.6 `continue`

条件：`signal_type === 'effective'`。

- `rollback_count` 不变；**清零**该类型的连续回退计数与锁定。

### 3.7 兜底

以上都不命中 ⇒ `action='continue'`（例如信号类型未知），`reason` 说明兜底原因。

## 4. 状态更新不变量

- `nextState.round = state.round + 1`。
- `nextState.traces` = 旧 traces 追加一条本轮 `RoundTrace`（**永不丢弃历史**）。
- `RoundTrace.round` 与本轮编号一致（从 1 起）。
- `rollback_count` 只在 §3.3/§3.4 递增，其余不变；**任何情况下不得超过 `rollback_limit`**
  （达到上限后转为 `manual_intervention`）。
- `reason` 恒非空；`RoundTrace.note` 恒非空。
- 纯函数：不修改传入的 `state`（用深快照可验证）。

## 5. 输入校验

畸形输入抛 `ClisContractError`，**绝不返回兜底决策**：

| 条件 | code |
| --- | --- |
| `round` 非对象 / `execution` 或 `signal` 非对象 / `path` 非对象 | `INVALID_RESULT` |
| `state` 非对象 / `rollback_count` 非非负整数 / `traces` 非数组 | `INVALID_STATE` |
| `options.rollback_limit` 非正整数、`options.lock_rounds` 非非负整数 | `INVALID_OPTIONS` |

## 6. 验收要求

实现方 `packages/clis-orchestrator/test/`：六种 action 各 ≥1 例，另需：
- 回退上限：按 §3.1 的轮次表断言真实序列（回退、回退+锁定、锁定继续、回退、人工介入），
  并断言 `rollback_count` 全程 ≤ 上限；
- 震荡锁定：同一类型连续回退 2 次 ⇒ 之后一轮为 `lock_and_continue` 且 `rollback_count` 不增；
- 锁定期间即使 `type_misjudged` 也不回退；
- trace 永不丢弃。

验证方 `tests/` 另需覆盖：

1. 决策优先级：`manual_intervention` > 锁定 > `boundary_invalid` > `type_misjudged` > `switch_path` > `continue`。
2. `rollback_count` 永不超过上限（构造连续回退序列验证）。
3. 震荡锁定：同一类型连续 2 次回退 ⇒ 锁定生效一轮；`effective` 会清零锁定与计数。
4. trace 完整性：多轮后 `traces.length === round`，且每轮 `note` 非空。
5. 纯函数：`decide` 不修改入参（深快照）。
6. **职责边界静态检查**：`src/**` 不含 `@clis/clis-classifier` / `@clis/clis-strategy` / `@clis/clis-feedback` 的 import；
   不含四问符号；`inject` 恰为三个服务名。
7. 畸形输入 3 类错误码。
8. 端到端：真实 Cordis `Context` 依次装载四个插件，`ctx['clis.causalOrchestrator']` 可用；
   只装 orchestrator 时不可用（inject 未满足）。

## 7. 写作用域

| 成员 | 可写 |
| --- | --- |
| Lead | 根配置、`packages/clis-contracts/**`、`packages/clis-orchestrator/**`、`docs/**`、`reports/**` |
| clis-verifier | `tests/**` |