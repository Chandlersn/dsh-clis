# CLIS 系统级验收报告（步骤 5）

| 项目 | 值 |
| --- | --- |
| 被验系统 | CLIS 因果分层智能系统：contracts + classifier + strategy + feedback + orchestrator |
| 权威规格 | `docs/SPEC-classifier.md` / `SPEC-strategy.md` / `SPEC-feedback.md` / `SPEC-orchestrator.md` |
| 执行环境 | Windows / Node 22 / vitest 5.0.5 / TypeScript 5.9.3 |
| 执行时间 | 2026-10-25 18:30（Asia/Shanghai） |
| **结论** | **PASS**（但独立验收的强度有限，见 §4） |

## 1. 闸门实测（Lead 亲自执行）

```
D:\个人开发\CLIS> pnpm exec tsc -p tsconfig.json
TSC_EXIT=0

D:\个人开发\CLIS> pnpm exec vitest run
 Test Files  32 passed (32)
      Tests  442 passed (442)
VITEST_EXIT=0
```

失败明细：**无**。

## 2. 五个组件与测试分布

| 组件 | 包内测试 | 独立验收 | 合计 |
| --- | --- | --- | --- |
| `clis-contracts` | 2 | — | 2 |
| `clis-classifier` | 38 | 105 | 143 |
| `clis-strategy` | 34 | 85 | 119 |
| `clis-feedback` | 22 | 81 + 19（Lead 补） | 122 |
| `clis-orchestrator` | 27 | 7（任务书逐条） | 34 |
| 系统端到端 | — | 11 | 11 |
| **合计** | **123** | **319** | **442** |

## 3. 系统级硬约束的验证结果

| 硬约束 | 验证方式 | 结论 |
| --- | --- | --- |
| 生成与判断分离 | classifier 的结论即 orchestrator 所用类型；strategy 每条路径的 `causal_type` 与输入一致 | PASS |
| 回退由 orchestrator 执行 | `ExecutionResult` 无回退字段（strategy 静态检查）；`FeedbackSignal` 只有 `suggested_rollback`（feedback 静态检查）；回退动作只出现在 orchestrator 的 `decide` | PASS |
| 契约先行 | 四插件 `package.json` 只依赖 `@clis/clis-contracts`；静态检查禁止 import 其它插件实现 | PASS |
| 置信度上限 0.9 | 81 组全矩阵扫描，最大观测值 0.9，无一例 `=== 1` | PASS |
| 回退上限 3 次 | 连续回退序列断言 `rollback_count ≤ 3`，触顶输出 `manual_intervention` | PASS |
| 震荡锁定 ≥1 轮 | 同类型连续回退 2 次触发锁定；锁定期 `rollback_count` 不增 | PASS |
| 完整 trace | 每轮一条，`traces.length === round`，`note` 恒非空，人工介入时仍追加 | PASS |

## 4. 独立验收的强度限制（必须如实说明）

本项目原计划"实现者与验收者分离"，但**验收 agent 在整个过程中崩溃三次**（classifier 阶段 2 次、strategy 阶段 1 次、feedback 阶段 1 次），且多次无收尾消息。实际情况：

- **classifier**：验收方独立写出 105 例套件并产出报告，独立性较好。
- **strategy**：套件由验收方独立写出，但**报告由 Lead 补写**（验收方崩溃在写报告时）。
- **feedback**：验收方写出 81 例（rules 32 / invariants 21 / malformed 28）后崩溃；**e2e 与静态边界检查 19 例由 Lead 补写**。
- **orchestrator**：**无独立验收方**，全部由 Lead 自测（含任务书逐条验收 7 例）。

因此本报告**不是一份全程独立验收**。缓解措施与残余风险：

1. 每份套件都先于"实现修正"存在：strategy 的 `rank` 缺陷、orchestrator 的锁定/上限冲突，都是套件先红、实现后改。
2. 关键边界用例由**非实现者**写（feedback 的 rules/invariants/malformed、strategy 全部、classifier 全部）。
3. 残余风险：feedback 的 e2e 与静态检查、orchestrator 的全部验收，均由实现者本人设计断言 —— 存在"按自己的实现写断言"的可能。

## 5. 验收期间发现并修复的实质缺陷（5 个）

| # | 组件 | 缺陷 | 危害 |
| --- | --- | --- | --- |
| 1 | classifier | SPEC §4.1 公式与表格在 R4 上自相矛盾（公式推 0.9/0.82，表格是 0.4/0.25） | 实现与验收各取一支会互不兼容 |
| 2 | strategy | 声明式不可执行路径被误跑（禁动作已从 steps 剔除，预检看不到） | 缺步的因果链被执行，如未定位反馈环就直接干预杠杆点 |
| 3 | strategy | 兄弟子路径都带 `rank: 1` | 违反"同级名次从 1 起连续"，调用方取错路径 |
| 4 | orchestrator | 震荡锁定与回退上限冲突：锁定使"连续 3 次回退"永不可达 | 上限形同虚设（已改为按真实叠加序列断言） |
| 5 | orchestrator | `run()` 中 `switch_path` 路径用尽即判 `exhausted`，浪费了回退机会 | 类型假设可能确实错，却因路径数量少而提前放弃 |

## 6. 复现命令

```powershell
$env:Path = "D:\nvm\v22.23.3;" + $env:Path
pnpm exec tsc -p tsconfig.json     # 期望 exit 0
pnpm exec vitest run               # 期望 32 文件 442 例全绿
```

> 本机坑：宿主重启后 pnpm 不在 PATH；vitest 若报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，
> 删 `node_modules\.vitest-cache` 后重跑；PowerShell 管道会吞退出码，判闸门时用 `> $null 2>&1; $LASTEXITCODE`。

## 7. 本轮无法验证的部分

1. **真实 LLM 语义分类**：classifier 是确定性规则打分（用户选定），不是语义理解；未验自然语言输入路径。
2. **真实副作用执行**：执行器是调用方提供的 fake，未接真实系统动作。
3. **长程闭环**：`max_rounds` 32 之外的长程行为未验。
4. **性能与并发**：未测。
5. **Cordis 生产装载**：四插件以独立 pnpm 包存在，未打包成 DSH 可安装 bundle（用户选择"不装进 DSH"）。