# 冻结规格 · clis-classifier

> 状态：**FROZEN**（Lead 定稿，2026-10-25）。实现者与独立验证者都以本文件为准。
> 本文件只冻结「对外可观测行为」，不规定内部文件划分。

## 1. 边界（硬约束）

clis-classifier **只做因果类型判断**。禁止：

- 生成策略、候选路径或排序（那是 clis-strategy）。
- 执行任何动作、修改系统状态。
- 评价策略好坏、决定回退（那是 clis-feedback / clis-orchestrator）。
- `import` 任何其它 CLIS 插件的实现文件 —— 只依赖 `@clis/clis-contracts`。
- 在 `classify` 里调用策略或执行逻辑。
- 返回 `confidence === 1.0`，或任何 > `CONFIDENCE_CEILING`(0.9) 的值。

## 2. 公开面（必须逐字匹配，验证方按此写测试）

包 `@clis/clis-classifier` 的入口 `packages/clis-classifier/src/index.ts` 必须导出：

| 导出 | 形状 | 说明 |
| --- | --- | --- |
| `name` | `'clis-classifier'` | 插件名 |
| `inject` | `[]` | 无服务依赖（只依赖契约包） |
| `apply` | `(ctx: Context) => void` | 通过 `ctx` 注册分类器服务 |
| `classifyProblem` | `(problem: CausalProblem, options?: ClassifyOptions) => CausalClassification` | **纯函数**：同步、确定性、无 I/O |
| `ClassifierService` | `class extends Service implements CausalClassifierService` | Cordis 服务实现 |

- `apply(ctx)` 必须让 `ctx['clis.causalClassifier']` 在装载后可用，且提供能通过 `ctx['clis.causalClassifier'].classify(problem)` 取到与 `classifyProblem` **完全相同**结论的服务（异步包装即可）。
- 服务名常量：`CAUSAL_CLASSIFIER_SERVICE`（来自契约包，值 `'clis.causalClassifier'`）。

## 3. 输入校验

畸形输入必须抛 `ClisContractError`（来自契约包），**绝不返回兜底结论**：

| 条件 | code |
| --- | --- |
| `problem` 不是对象 / `description` 不是字符串 / `sub_problems` 不是数组 / 数组元素不是合法 problem / `label` 存在但不是字符串 | `INVALID_PROBLEM` |
| `answers` 不是对象，或四个字段有任一缺失/非法三态值 | `INVALID_ANSWERS` |
| `options.max_depth` 存在但不是 `[0, MAX_DEPTH_LIMIT]` 内的整数 | `INVALID_OPTIONS` |

- `description` 允许空串。
- `answers` 多余的键**忽略**；四个字段必须齐全且为 `'yes' | 'no' | 'unknown'`。
- `details` 必须给出字段级 `path` / `expected` / `received`。

## 4. 判据规则表（确定性，无随机、无时间依赖）

记号：`Q1..Q4` 指四问作答；`d` = Q1/Q2/Q3 中回答 `yes` 的**不同类型**个数；`unknownCount` = 四问中 `unknown` 的个数。

| 规则 | 条件 | 结论 |
| --- | --- | --- |
| **R1** | `Q4 === 'yes'` | 类型 = `nested` |
| **R2** | `Q4 !== 'yes'` 且 `d === 1` | 类型 = 该唯一 `yes` 对应的类型 |
| **R3** | `Q4 !== 'yes'` 且 `d >= 2` | 类型 = `nested`（结构冲突：多种结构并存却未确认嵌套） |
| **R4** | `d === 0` 且 `Q4 !== 'yes'` | 类型 = `unknown`（不强行归类） |
| **R5** | 每有一个 `unknown` 作答 | 置信度扣 **0.08** |
| **R6** | R3 触发 | 置信度再扣 **0.15** |
| **R7** | 最终 `confidence < 0.7` | `needs_exploration = true` |
| **R8** | 恒 | `confidence = min(confidence, 0.9)`（再保留两位小数） |
| **R9** | R1/R3 且存在 `sub_problems` 且未达深度上限 | 递归生成 `sub_modules` |
| **R10** | R1/R3 但无 `sub_problems`，或已达深度上限 | `sub_modules = []` |
| **R11** | R4 | 输出 `candidate_hypotheses`（降序；同分按类型表顺序） |

`judgment_basis` 必须**每条规则各一项**（R1–R11 全部出现，`fired` 标明是否触发，触发的给出 `effect`）。

### 4.1 基础分与实例

基准分 `base = 0.9`，最终 `confidence = normalizeConfidence(base - 0.08 * unknownCount - (R3 ? 0.15 : 0))`。

| 情形 | unknownCount | confidence | needs_exploration |
| --- | --- | --- | --- |
| R2，`d=1` | 0 | `0.9` | false |
| R2，`d=1` | 1 | `0.82` | false |
| R2，`d=1` | 2 | `0.74` | false |
| R2，`d=1` | 3 | `0.66` | **true** |
| R1，`Q4=yes` | 0 | `0.9` | false |
| R1，`Q4=yes` | 1 | `0.82` | false |
| R3，`d>=2` | 0 | `0.75` | false |
| R3，`d>=2` | 1 | `0.67` | **true** |
| R4，四问全 `no` | 0 | `0.4` | **true** |
| R4，含至少一个 `unknown` | ≥1 | `0.25` | **true** |

- R4 时 `exploration_reason` 必须非空：全 `no` 说明"已排除四种已知类型但无法给出类型，禁止强行归类"；含 `unknown` 说明"作答不足，信息不足以判断类型"。
- `needs_exploration === true` 时 `exploration_reason` 必须存在且非空。

### 4.2 R4 的候选假设

`candidate_hypotheses` 覆盖 `KNOWN_CAUSAL_TYPES` 全部四项：

- 四问全 `no`：每项 `confidence = 0.3`。
- 否则（含 `unknown`）：每项 `confidence = 0.2`。
- 排序：置信度降序；同分保持 `KNOWN_CAUSAL_TYPES` 顺序（`structural_duality, cyclic, unidirectional, nested`）。
- `rationale` 非空。
- 非 `unknown` 结论时 `candidate_hypotheses` 必须**不存在**（`undefined`）。

### 4.3 嵌套拆分

- `causal_type === 'nested'` 时 `sub_modules` **字段必须存在**（可能为空数组）。
- 有 `sub_problems`：每个子问题递归分类（`depth + 1`），`name = sub.label ?? 'sub-' + (i+1)`（i 从 0 起）。
- 深度：根为 `depth = 0`；当 `depth + 1 > max_depth` 时不再下探，`sub_modules = []`。
  - `max_depth` 缺省 `DEFAULT_MAX_DEPTH (3)`。
  - `max_depth = 0` ⇒ 根若为 nested 也直接 `[]`。
- 子问题自身畸形同样抛 `ClisContractError`。
- 拆分发生时追加一条 `SUBMODULE` 来源证据，`statement` 含子模块数量与名字。
- 非 `nested` 结论时 `sub_modules` 必须**不存在**（`undefined`）。

## 5. 证据不变量

- `evidence` **恒非空**，且每条 `statement` 都是非空字符串。
- 每个 `yes` 作答产生一条证据（`source` 为对应 `Qn`，`supports` 为对应类型，`weight = 1`）。
- R3 触发时额外给出一条 `RULE` 来源的冲突证据。
- R4 时每个问题各给出一条"作答状态"证据（`supports: 'unknown'`，`weight: 0`）；`description` 非空时再给出一条描述证据（截断至 120 字符，超出补 `…`）。
- 末尾恒有一条 `RULE` 来源的"主判据"证据，`statement` 含所触发的主规则，`weight = 最终 confidence`。
- `weight` 范围 `[0, 1]`。

## 6. 验收用例（最低要求，实现方与验证方各写一份）

实现方 `packages/clis-classifier/test/`：

| 类型 | 条数 |
| --- | --- |
| `structural_duality` | 2 |
| `cyclic` | 2 |
| `unidirectional` | 2 |
| `nested` | 1 |
| `unknown` | 1 |

每条用例必须断言：**类型正确** + **`evidence` 非空且每条 `statement` 非空**。

验证方 `tests/`（独立、黑盒、不读实现）另需覆盖：

1. 置信度上限：任何输入下 `0 < confidence <= 0.9`，且**永不等于 1.0**。
2. 探索模式边界：`0.66 → true`、`0.74 → false`（R2 的 3/2 个 unknown）。
3. R3 冲突路径：`Q1=yes, Q2=yes, Q4=no` ⇒ `nested`，`confidence = 0.75`。
4. `needs_exploration === true` ⇒ `exploration_reason` 非空；`false` ⇒ 该字段不存在。
5. `unknown` ⇒ 有 `candidate_hypotheses`，且四种类型齐全、降序；非 `unknown` ⇒ 无该字段。
6. `nested` ⇒ 有 `sub_modules`；非 `nested` ⇒ 无该字段。
7. 嵌套递归：给 2 个子问题（其一为 `cyclic`，其一为 `unidirectional`）⇒ `sub_modules` 长度为 2 且各自类型正确。
8. `max_depth = 0` 且根为 `nested` ⇒ `sub_modules = []`。
9. 畸形输入：缺字段 / 非法三态值 / `max_depth = -1` / `max_depth = 99` ⇒ 抛 `ClisContractError` 且 `code` 正确。
10. 确定性：同一输入连续两次 `classifyProblem` 结果深度相等。
11. 端到端：用 `@deepseek-ai/cordis` 真实 `Context` 装载插件（`ctx.plugin` 后 `inject: ['clis.causalClassifier']`），取到服务并 `await classify(...)`，结论与 `classifyProblem` 一致。
12. 职责边界静态检查：`packages/clis-classifier/src/**` 不含对 `@clis/clis-strategy` / `@clis/clis-feedback` / `@clis/clis-orchestrator` 的 import，且 `confidence` 无字面量 `1.0`/`1` 赋值。

## 7. 写作用域

| 成员 | 可写 |
| --- | --- |
| Lead | 根配置、`packages/clis-contracts/**`、`docs/**`、`README.md` |
| classifier-dev | `packages/clis-classifier/**` |
| clis-verifier | `tests/**` |

任何人不得改他人作用域内的文件；需要改动先在团队任务/消息里说。