# 冻结规格 · clis-strategy

> 状态：**FROZEN**（Lead 定稿，2026-10-25）。实现者与独立验证者都以本文件为准。
> 本文件只冻结「对外可观测行为」，不规定内部文件划分。

## 1. 边界（硬约束）

clis-strategy **只做策略匹配、候选路径生成、排序与执行**。禁止：

- 重新判断因果类型（判据完全来自传入的 `CausalClassification`）。
- 自行决定或执行回退；`ExecutionResult` 不得含任何回退决策字段。
- 执行 `boundary.forbidden_actions` 中的动作（生成与执行两处都要挡）。
- 直接调用 FeedbackService 或依赖 clis-feedback / clis-orchestrator。
- `import` 任何其它 CLIS 插件的实现文件 —— 只依赖 `@clis/clis-contracts`。
- 把策略写成自然语言忠告：每个动作必须参数化且名字取自 §3 的动作集合。

## 2. 公开面（必须逐字匹配，验证方按此写测试）

包 `@clis/clis-strategy` 的入口 `packages/clis-strategy/src/index.ts` 必须导出：

| 导出 | 形状 | 说明 |
| --- | --- | --- |
| `name` | `'clis-strategy'` | 插件名 |
| `inject` | `['clis.causalClassifier']` | 只注入分类器抽象接口，用于**读取**类型 |
| `apply` | `(ctx: Context) => void` | 通过 `ctx` 注册 `StrategyService` |
| `StrategyServiceImpl` | `class extends Service implements StrategyService` | Cordis 服务实现 |
| `STRATEGY_LIBRARY_VERSION` | `string`（`'1.0.0'`） | 策略库版本 |
| `STRATEGY_LIBRARY` | `readonly LibraryVariant[]` | 策略库本体（参数化、可版本化） |
| `matchPaths` | `(classification, boundary, options?) => readonly CandidatePath[]` | **纯函数**：同步、确定性、无 I/O |
| `executePath` | `(path, options) => Promise<ExecutionResult>` | 执行（需要执行器） |

服务名常量：`CAUSAL_STRATEGY_SERVICE`（契约包，值 `'clis.causalStrategy'`）。

## 3. 策略库（参数化 + 可版本化）

- 库版本 `STRATEGY_LIBRARY_VERSION = '1.0.0'`；每个变体另有 `variant_version`（同为 `'1.0.0'`）。
- 每个变体由**四个分量**描述（各自 [0,1]，越大越好）：`type_fit`、`expected_effect`、`side_effect_risk`、`execution_cost`。
- 每个变体由**参数化动作**组成：动作名取自下表，参数是结构化对象。

### 3.1 变体与分量（逐字固定）

| 变体 | 家族 | type_fit | expected_effect | side_effect_risk | execution_cost |
| --- | --- | --- | --- | --- | --- |
| `duality.symmetric_mapping` | duality_pairing | 1.0 | 0.90 | 0.20 | 0.40 |
| `duality.relation_tuning` | duality_pairing | 1.0 | 0.75 | 0.15 | 0.30 |
| `duality.definition_clarification` | duality_pairing | 1.0 | 0.60 | 0.05 | 0.20 |
| `loop.leverage_point` | loop_damping | 1.0 | 0.90 | 0.25 | 0.45 |
| `loop.gain_control` | loop_damping | 1.0 | 0.80 | 0.20 | 0.30 |
| `loop.delay_tuning` | loop_damping | 1.0 | 0.70 | 0.15 | 0.30 |
| `loop.damping_injection` | loop_damping | 1.0 | 0.65 | 0.10 | 0.35 |
| `lever.necessary_condition` | single_lever | 1.0 | 0.80 | 0.20 | 0.30 |
| `lever.upstream_trace` | single_lever | 1.0 | 0.85 | 0.30 | 0.40 |
| `lever.irreversibility_acceptance` | single_lever | 1.0 | 0.50 | 0.05 | 0.10 |
| `lever.new_causal_overlay` | single_lever | 1.0 | 0.70 | 0.35 | 0.50 |
| `decompose.compose_sub` | decompose | 1.0 | 0.80 | 0.25 | 0.55 |
| `probe.minimal` | probe_and_observe | 1.0 | 0.50 | 0.10 | 0.15 |
| `probe.broad` | probe_and_observe | 1.0 | 0.70 | 0.30 | 0.45 |

**低置信度附加候选**：当探索候选被追加到某个**已知类型**的候选集里时，其 `type_fit` 取 **0.5**（其余分量照上表）。

### 3.2 动作与步骤（逐字固定）

| 变体 | 步骤（按序） |
| --- | --- |
| `duality.symmetric_mapping` | `identify_poles{pair}` → `apply_symmetric_adjustment{magnitude,target:'both_poles'}` |
| `duality.relation_tuning` | `measure_relation_parameters{dimensions}` → `tune_relation_parameter{parameter,delta}` |
| `duality.definition_clarification` | `extract_definitions{sources}` → `resolve_definition_conflict{strategy:'prefer_explicit'}` |
| `loop.leverage_point` | `map_feedback_loop{nodes}` → `rank_leverage_points{metric:'gain_over_delay'}` → `intervene_at_leverage_point{target,strength}` |
| `loop.delay_tuning` | `measure_loop_delay{unit}` → `shift_delay{delta,direction}` |
| `loop.gain_control` | `measure_loop_gain{method}` → `limit_gain{max_gain}` |
| `loop.damping_injection` | `inject_damping{coefficient,at}` |
| `lever.upstream_trace` | `trace_upstream{max_depth}` → `select_upstream_intervention{chosen}` → `apply_intervention{strength}` |
| `lever.necessary_condition` | `enumerate_conditions{candidates}` → `test_necessity{method:'remove_one'}` → `enforce_condition{condition}` |
| `lever.new_causal_overlay` | `design_overlay_cause{target_effect}` → `apply_overlay{strength}` |
| `lever.irreversibility_acceptance` | `confirm_irreversibility{evidence}` → `accept_and_plan_around{constraint}` |
| `decompose.compose_sub` | `partition_sub_modules{count}`（子模块另出子路径） |
| `probe.minimal` | `probe_environment{targets,sample_size:1}` → `observe_response{window:1,metrics:['signal']}` |
| `probe.broad` | `probe_environment{targets,sample_size:5}` → `observe_response{window:5,metrics:['signal','trend','noise']}` |

- 每个 `PathStep.params` 恒为对象（可为空对象），`rationale` 非空且 ≤60 字。
- `PathStep.index` 从 0 起、连续。

## 4. 匹配与排序

1. **家族选择**：`causal_type` 为已知类型时取 `FAMILY_BY_TYPE[type]`；为 `unknown` 时取 `probe_and_observe`。
2. **候选集**：
   - 该家族的全部变体；
   - 另追加 `probe.minimal`（`type_fit = 0.5`）当且仅当：`classification.needs_exploration === true` 且 `causal_type !== 'unknown'`；或 `causal_type === 'nested'` 且 `sub_modules` 为空。追加时不重复（集合内已有则不再加）。
3. **排序分**：由契约包的 `scorePath()` **唯一实现**计算，权重固定为 `type_fit 0.4 / expected_effect 0.3 / side_effect_risk 0.2 / execution_cost 0.1`，其中"副作用风险"与"执行成本"以 `(1 - 值)` 进入 —— **风险越低、成本越低，得分越高**。
   - 因此第一个变体（最高分）必是 `type_fit` 最大者优先。低置信度追加的探索候选（`type_fit 0.5`）必然排在家族自有变体之后。
4. **rank**：同级内按 `score` 降序，同分按 `PATH_VARIANTS` 的声明顺序（稳定）；名次从 1 起连续。
   - **rank 只由 score 决定**：整条不可执行的路径不会被自动降级 —— 调用方必须**先按 `executable` 过滤**再取 rank 1。这一点是刻意的（排序公式里没有边界项），已在此明写。
5. **path_id**：根路径按 `PATH_VARIANTS` 声明顺序编号 `p1..pn`（**与分数无关，可复现**）；子路径为 `<父 id>.<k>`，`k` 从 1 起按子模块顺序。
6. **子路径选择**：每个子模块取该子模块候选集中**名次最好的可执行候选**（`executable === true`）；若该子模块全部候选都不可执行，则退化为 rank 1（该子路径执行时会被判 `blocked`）。
   - 选中后，兄弟子路径在**同一层内按 `score` 重新排名**（`rank` 从 1 起连续）—— `rank` 的定义是"同级名次"，直接沿用它在自己候选集里的 rank 会得出多条并列 rank 1。
   - `sub_paths` 数组顺序即重排后的名次顺序（与根层一致：数组顺序 = rank 顺序）；`path_id` 仍按子模块顺序编号，两者可以不同序。
7. `summary` 非空且 ≤80 字；`expected_effect` 等分量原样放在 `components` 里，便于复核 `score === scorePath(components)`。

## 5. 边界剔除（"不含禁止动作"）

- 生成阶段：逐步检查 `blockedReason(action, boundary)`，命中者**从 `steps` 中剔除**，并在 `blocked_actions` 记一条 `{action, reason}`（同一动作名只记一条）。
- 因此**返回的每条路径的 `steps` 都不含被禁止的动作**（这就是验收项"不含禁止动作"）。
- `executable = blocked_actions.length === 0`。
- 分量与 `score` **不因剔除而改动**（公式只有四项）；被剔除的路径只是不可执行。
- 执行阶段：对传入路径**再次**过滤（路径是数据，可能是调用方手搓的）；任何被阻断的动作一律不交给执行器。

## 6. 执行与信号

`execute(path, options)` 产出 `ExecutionResult`。规则：

1. **预检**：按 `steps` 序检查每个动作是否被边界阻断。若**任一**被阻断：
   - `status = 'blocked'`，**不调用执行器任何一次**（宁可整条不做，也不做半截）；
   - 被阻断的步骤各记一条 `skipped_forbidden` 信号；其余步骤各记一条 `not_attempted`（detail 说明"本路径已被边界阻断，未执行任何步骤"）。

   **另一种同样整条不执行的情形**（2026-10-25 安全补注，实现与验收都必须覆盖）：路径自身声明
   `executable === false` 或 `blocked_actions` 非空 —— 即生成阶段已经剔除过动作。这类路径的
   `steps` 里**看不到**被剔除的动作，若只按上面那条规则做预检就会误判为"可执行"，从而把一条
   缺步的因果链跑完（例如没定位反馈环就直接去干预杠杆点）。因此：
   - 声明式不可执行 **也**一律 `status = 'blocked'`、执行器调用次数为 0；
   - 这类路径上不会出现 `skipped_forbidden` 信号（对应动作已不在 `steps` 里），
     阻断记录只在 `blocked_actions` 与汇总信号中体现。
2. 无阻断时依序调用 `executor.execute({path_id, step_index, action, params})`：
   - 返回 `ok` → 记 `observed` 信号（detail 取执行器回执）；
   - 返回 `failed` → 记 `failed` 信号，**停止后续调用**，剩余步骤各记 `not_attempted`（detail 说明"前序步骤失败，未执行"），`status = 'failed'`；
   - 全部 `ok` → `status = 'succeeded'`。
3. `decompose` 家族（`sub_paths` 存在且非空）：
   - 父自身被阻断或自身某步失败 → 对应的 `blocked` / `failed`，**不执行任何子路径**；
   - 否则先执行父自身步骤，再按序执行每个子路径，结果放进 `sub_results`（顺序与 `sub_paths` 一致）；
   - 父 `status` 汇总：任一子 `failed` → `failed`；否则任一子 `blocked` → `blocked`；否则 `succeeded`；
   - **某条子路径失败不阻止其余子路径**（2026-10-25 澄清）：子模块彼此独立，后续子路径照常执行；
     失败子路径自身的后续步骤按 §6.2 记 `not_attempted`。
     因此"断言执行器总调用次数"是**不稳定**的判据 —— 请断言各子路径的 `status`、
     `sub_results` 的长度与顺序、以及"失败/被阻断子路径的步骤确实没被调用"。
4. **信号不变量**：`signals` 恒非空，**末条恒为 `kind: 'summary'`**（`step_index = -1`、`action = 'summary'`），detail 汇总步骤数与最终状态。每条 `detail` 非空。
5. `blocked_actions` 反映预检发现的阻断项（去重）。
6. **不得出现** `rollback` / `suggested_rollback` / `next_action` 之类字段 —— 回退由 orchestrator 决定。

## 7. 验收要求

实现方 `packages/clis-strategy/test/`：

| 要求 | 条数 |
| --- | --- |
| `structural_duality` 策略匹配用例 | ≥2 |
| `cyclic` 策略匹配用例 | ≥2 |
| `unidirectional` 策略匹配用例 | ≥2 |
| `nested`（含子路径递归） | ≥1 |
| `unknown`（探索） | ≥1 |

每条用例必须断言：家族正确 + 至少 1 条候选路径 + 候选路径的 `steps` 不含被禁止动作。

验证方 `tests/` 另需覆盖：

1. **排序公式可复算**：对每条返回路径断言 `score === scorePath(components)`（用契约包函数）。
2. **排序优先类型匹配度**：构造只差 `type_fit` 的两个候选，高分者 rank 更小；且已知类型在低置信度下，家族自有变体（`type_fit 1.0`）全部排在追加的探索候选（`type_fit 0.5`）之前。
3. `rank` 由 score 降序、同分按 `PATH_VARIANTS` 顺序、从 1 起连续。
4. `path_id` 可复现：同一输入两次调用，`path_id` 与 `rank` 完全一致。
5. **不含禁止动作**：把某变体的一个动作放进 `forbidden_actions`，断言返回路径的 `steps` 不含它、`blocked_actions` 有它、`executable === false`。
6. 白名单：`allowed_actions` 存在时，不在名单内的动作同样被剔除（`reason === 'not_in_allowlist'`）；与黑名单同时命中时以黑名单为准。
7. **执行器绝不被喂禁止动作**：手搓一条含禁止动作的路径交给 `execute` ⇒ `status === 'blocked'` 且执行器**调用次数为 0**。
8. 执行信号：全 `ok` ⇒ `succeeded` 且信号含 `observed`；执行器某步 `failed` ⇒ `failed` 且后续步骤为 `not_attempted`；末条恒 `summary`；`signals` 恒非空、detail 非空。
9. `decompose`：nested + 2 个子模块 ⇒ `sub_paths` 长度 2、各子路径家族对应其类型、`sub_results` 长度 2；子路径被阻断时父 `status` 为 `blocked`。
10. 深度：`max_depth = 0` 时不展开子路径（无 `sub_paths`）。
11. **职责边界静态检查**：`packages/clis-strategy/src/**` 不含 `@clis/clis-feedback` / `@clis/clis-orchestrator` 的 import，不含判据（不得出现 `FOUR_QUESTIONS` / `q1_simultaneous_mutual_definition` 等分类器符号），`ExecutionResult` 相关代码不出现 `rollback` 字段。
12. 端到端：真实 Cordis `Context` 里先 `ctx.plugin(clisClassifier)` 再 `ctx.plugin(clisStrategy)`，取 `ctx['clis.causalStrategy']`，`await match(...)` 与纯函数 `matchPaths(...)` 结论一致，且 `plan(problem, boundary)` 能通过注入的分类器取得类型后返回路径。
13. `inject` 依赖：单独装载 strategy（不装 classifier）时 `ctx['clis.causalStrategy']` 不可用；装齐后可用。

## 8. 写作用域

| 成员 | 可写 |
| --- | --- |
| Lead | 根配置、`packages/clis-contracts/**`、`packages/clis-strategy/**`、`docs/**`、`README.md` |
| clis-verifier | `tests/**`、`reports/**` |