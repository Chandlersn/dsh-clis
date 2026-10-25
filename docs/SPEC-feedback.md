# 冻结规格 · clis-feedback

> 状态：**FROZEN**（Lead 定稿，2026-10-25）。实现者与验证者都以本文件为准。

## 1. 边界（硬约束）

clis-feedback **只做反馈信号检测、类型误判识别、回退建议输出**。禁止：

- 重新判断因果类型：**不得调用 classifier**，不得使用四问作答或任何分类判据。
- 自动执行回退：**只输出 `suggested_rollback`**，不修改任何系统状态。
- 重新执行策略或调用 strategy 的实现。
- `import` 任何其它 CLIS 插件的实现文件 —— 只依赖 `@clis/clis-contracts`。
- 在输出中出现 `executed` / `applied` / `rollback_performed` 之类"已执行"语义字段。

## 2. 公开面（逐字匹配）

`packages/clis-feedback/src/index.ts` 必须导出：

| 导出 | 形状 |
| --- | --- |
| `name` | `'clis-feedback'` |
| `inject` | `[]`（**不注入分类器** —— 从依赖图层面就无法重新分类） |
| `apply` | `(ctx: Context) => void` |
| `FeedbackServiceImpl` | `class extends Service implements FeedbackService` |
| `detectSignal` | `(request, options?) => FeedbackSignal`，**纯函数**：同步、确定性、无 I/O |
| `FEEDBACK_RULES_VERSION` | `'1.0.0'` |

服务名：`CAUSAL_FEEDBACK_SERVICE`（值 `'clis.causalFeedback'`）。

## 3. 四种信号类型的判定（优先级从上到下，命中即返回）

判定输入：`result`（ExecutionResult）、`classification.causal_type`（只读假设）、`boundary`、`history`。

### 3.1 `boundary_invalid`（最高优先级）

触发（任一）：
- **B1**：`history.previous_signals` 中 `ineffective` 的累计次数 ≥ `boundary.max_rounds`（`max_rounds` 缺省 3）—— 即"一直没效果还继续加码"。
- **B2**：`result.blocked_actions` 非空 —— 执行期已发生越界拦截。
- **B3**：`result.status === 'blocked'` —— 整条因越界未执行。

`suggested_rollback`：**无**（越界不是类型问题，回退类型无意义）。

### 3.2 `type_misjudged`

触发（任一），且必须同时满足"偏离是反复的"（`previous_signals` 中已有 ≥1 个 `ineffective` 或 `type_misjudged`）：

| 规则 | 假设类型 | 偏离模式 | `suggested_rollback` |
| --- | --- | --- | --- |
| **M1** | `unidirectional` | 干预无效且问题反复（`status !== 'succeeded'`） | `{kind:'recheck_type', target:'cyclic'}` |
| **M2** | `cyclic` | 越干预越糟（`status === 'failed'`） | `{kind:'recheck_type', target:'unidirectional'}` |
| **M3** | `structural_duality` | 一方单方面改定义（存在 `unilateral_definition_change` 信号） | `{kind:'recheck_type', target:'unidirectional'}` |
| **M4** | `structural_duality` | 强行引入反馈后失稳（存在 `feedback_introduced` 且 `status === 'failed'`） | `{kind:'restore_type', target:'structural_duality'}` |

- 偏离模式由 `result.signals` 里的 `kind` 与 `detail` 判定；为此约定三种**模式信号**（由执行器 detail 携带，见 §3.4）。
- M4 是**回到原类型**（`restore_type`），M1–M3 是**换一种假设再试**（`recheck_type`）—— 二者语义不同，不可混用。

### 3.3 `ineffective`

触发：`result.status !== 'succeeded'` 且未命中 §3.1/§3.2。含义：结果偏离，但**类型假设仍成立**（偏离尚未反复到足以推翻假设）。

`suggested_rollback`：无。

### 3.4 `effective`

触发：`result.status === 'succeeded'` 且 `boundary.require_all_ok !== false` 时所有步骤均 `ok`；`require_all_ok === false` 时只要 `status === 'succeeded'`。

`suggested_rollback`：无。

**模式信号约定**（`result.signals[].detail` 中出现的标记词，大小写敏感）：
- `unilateral_definition_change` —— 一方单方面改定义
- `feedback_introduced` —— 强行引入了反馈
- `worsened` —— 越干预越糟

## 4. 输出不变量

- `reason` 恒非空字符串。
- `evidence` **恒非空**，每条 `statement` 非空；必须包含**触发该结论的那条规则**（`rule_id` 为 `B1`/`M1` 等）。
- `assumed_type` 原样回显 `classification.causal_type`。
- `suggested_rollback` **仅在** `type_misjudged` 时存在；其余三种信号该字段必须**不存在**（`undefined`，不是 `null`）。
- `suggested_rollback.target_type` 必须是 `KNOWN_CAUSAL_TYPES` 之一；`rationale` 非空且 ≤120 字。
- 输出**不得**含任何表示"已执行回退"的字段。

## 5. 输入校验

畸形输入抛 `ClisContractError`，**绝不返回兜底信号**：

| 条件 | code |
| --- | --- |
| `request` 非对象 / `result` 非对象 / `result.signals` 非数组 / `result.status` 非法 | `INVALID_RESULT` |
| `classification` 非对象 / `causal_type` 非法 | `INVALID_CLASSIFICATION` |
| `boundary` 非对象 / `forbidden_actions` 非数组 | `INVALID_BOUNDARY` |
| `options.history.previous_signals` 存在但非数组，或含非法信号类型 | `INVALID_OPTIONS` |

## 6. 验收要求

实现方 `packages/clis-feedback/test/`：**四种信号类型各 ≥2 例**，另需构造"把循环因果当单向因果"的误判场景 ⇒ 输出 `type_misjudged`。每条断言：`signal_type` 正确 + `reason` 非空 + `evidence` 非空且每条 `statement` 非空。

验证方 `tests/` 另需覆盖：

1. 四种类型各自的判定优先级（`boundary_invalid` > `type_misjudged` > `ineffective`/`effective`）。
2. M1–M4 四条规则逐条命中，且 `suggested_rollback.kind` 与 `target_type` 正确（M4 必须是 `restore_type`）。
3. `suggested_rollback` 只在 `type_misjudged` 时存在；其余三种必须 `undefined`。
4. **不得重新分类**：静态检查 `src/**` 不含 `@clis/clis-classifier` import、不含 `FOUR_QUESTIONS`/`q1_*` 等分类器符号；且 `inject` 为空数组。
5. **不得执行回退**：输出对象无 `executed`/`applied`/`rollback_performed` 字段；`detectSignal` 为纯函数（不改入参，用深快照比对）。
6. 畸形输入 4 类错误码。
7. 端到端：真实 Cordis `Context` 装载（`inject: []` ⇒ 无需其它插件即可用），服务结论与纯函数一致；卸载后服务消失。
8. 确定性：同输入两次 `toStrictEqual`。

## 7. 写作用域

| 成员 | 可写 |
| --- | --- |
| Lead | 根配置、`packages/clis-contracts/**`、`packages/clis-feedback/**`、`docs/**`、`reports/**` |
| clis-verifier | `tests/**` |