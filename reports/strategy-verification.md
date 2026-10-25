# clis-strategy 验收报告

| 项目 | 值 |
| --- | --- |
| 被验对象 | `packages/clis-strategy/src/**`（`library.ts` / `paths.ts` / `execution.ts` / `validation.ts` / `service.ts` / `index.ts`） |
| 权威规格 | [`docs/SPEC-strategy.md`](../docs/SPEC-strategy.md)（FROZEN） |
| 验收套件 | `tests/strategy-*.test.ts`（7 文件 + `strategy-helpers.ts`，strategy 部分 85 例） |
| 包内单测 | `packages/clis-strategy/test/*`（34 例） |
| 执行环境 | Windows / Node 22 / vitest 5.0.5 / TypeScript 5.9.3 |
| 执行时间 | 2026-10-25 17:45（Asia/Shanghai） |
| **结论** | **PASS** |

## 1. 闸门实测（Lead 亲自执行）

```
D:\个人开发\CLIS> pnpm exec tsc -p tsconfig.json
TSC_EXIT=0

D:\个人开发\CLIS> pnpm exec vitest run
 Test Files  20 passed (20)
      Tests  264 passed (264)
VITEST_EXIT=0
```

失败明细：**无**（0 failed / 0 skipped / 0 todo）。

> 说明：首次运行时 PowerShell 管道把退出码报成 1，属管道假象；已单独用 `> $null` 捕获真实退出码复测为 0。

构成：classifier 系 145 例（未回归）+ strategy 系 119 例（包内 34 + 独立 85）。

## 2. 独立性披露（重要，限制本报告证据强度）

**本报告不是一份纯独立验收。** 如实记录如下：

1. **原定独立验证者两次中途失败**，最后一次正在写本报告时崩溃且**未留下任何收尾消息**。因此它从未产出 `reports/strategy-verification.md`。
2. 它确实交付了 `tests/strategy-*.ts` 套件（7 文件 + helper），并报告过一次 `264/264`。但该数字此前**无法复核**（工具层故障，见 §5），本报告中的 264/264 是 **Lead 本人重新实测**的结果。
3. **套件作者与实现者不是同一人**（套件由 `clis-verifier` 写，实现由 Lead 写），这一点成立；但**最终验收判定由实现者本人做出**，因为验证者已崩溃。这是一个实质性的独立性削弱，不应被掩盖。
4. 套件在编写期间是否读过实现源码：验证者上一轮（classifier 阶段）的自述是"写套件期间未读 src，首次读 src 在其后"。strategy 阶段**无完整自述留存**，无法确认。
5. 可核验的补偿性证据：套件确实抓到了两个实现缺陷（见 §3），且其中一个（`rank` 冲突）的断言在实现修复前是红的 —— 若套件是从实现反推的，不会出现"期望与实现不一致"的情形。

**定性：这是"套件独立、判定不独立"的验收。** 若要更强证据，需要第三方在套件冻结后重跑。

## 3. 验收期间发现并修复的缺陷（2 个真实 bug）

| # | 缺陷 | 危害 | 修复 |
| --- | --- | --- | --- |
| 1 | **声明式不可执行路径被误跑** | 生成阶段会把被 `boundary` 阻断的动作从 `steps` 剔除；于是 `executable:false` 的路径对"只扫 steps"的预检看起来完全可执行，**跳过缺失步骤照跑**（最坏：未 `map_feedback_loop` 就直接 `intervene_at_leverage_point`） | 路径 `executable===false` 或 `blocked_actions` 非空 ⇒ 整条 `blocked`，执行器调用次数 0。SPEC §6.1 补注 |
| 2 | **兄弟子路径都带 `rank: 1`** | 违反"rank 是同级名次、从 1 起连续"；调用方按 rank 取路径会取错 | 兄弟子路径在同层内按 `score` 重排 1..N。SPEC §4.6 补注 |

缺陷 1 的防护：套件含一条**漏洞探针** —— 把生成态不可执行路径配**空边界**执行，仍须 `blocked` 且调用次数 0。只扫 steps 的实现会在这条用例上失败。

## 4. SPEC §7「验证方」13 项核对

| # | 要求 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | `score === scorePath(components)` 可复算 | PASS | `strategy-library.test.ts` |
| 2 | 排序优先类型匹配度 | PASS | `strategy-library.test.ts`：家族自有（type_fit 1.0）全部排在追加探索候选（0.5）之前 |
| 3 | rank 降序、同分按 PATH_VARIANTS、从 1 连续 | PASS | `strategy-library.test.ts` + `strategy-decompose.test.ts`（§4.6 兄弟重排） |
| 4 | path_id 可复现 | PASS | `strategy-library.test.ts`（两次调用 `toStrictEqual`） |
| 5 | 不含禁止动作 | PASS | `strategy-boundary.test.ts`：steps 无禁动作、`blocked_actions` 有、`executable=false` |
| 6 | 白名单 + 黑名单优先 | PASS | `strategy-boundary.test.ts`：`not_in_allowlist`；同时命中取 `forbidden` |
| 7 | 执行器绝不被喂禁止动作 | PASS | `strategy-boundary.test.ts`：生成态/手搓态/空边界三入口，`calls.length === 0` |
| 8 | 执行信号不变量 | PASS | `strategy-execution.test.ts`：`succeeded`/`failed`/`not_attempted`、末条恒 `summary`、detail 非空 |
| 9 | decompose 子路径 | PASS | `strategy-decompose.test.ts`：长度/顺序/各子 status/父汇总 |
| 10 | max_depth = 0 不展开 | PASS | `strategy-decompose.test.ts` |
| 11 | 职责边界静态检查 | PASS | `strategy-static.test.ts`：无 feedback/orchestrator import、无分类器判据符号、无 rollback 字段；含检查器自检 |
| 12 | 端到端（真实 Cordis Context） | PASS | `strategy-e2e.test.ts` |
| 13 | inject 依赖语义 | PASS | `strategy-e2e.test.ts`：仅装 strategy 时服务不可用，装齐后可用 |

## 5. 过程风险记录：工具层故障

验收期间 harness 的 auto-review 闸门发生全局故障（所有工具调用在执行前失败，返回原始 `<｜｜DSML｜｜` token 而非 JSON），自 2026-10-25 第 1 轮末持续约 19 轮，导致：

- 验证者的报告无法产出（其崩溃点正在此）；
- 本报告的 §1 闸门命令被迫延后到故障恢复后才执行；
- 期间无法提交 7 个 `tests/strategy-*.ts` 文件。

**结论不受影响**：§1 的 264/264 是故障恢复后 Lead 亲自实测。

## 6. 本轮无法验证的部分

1. **跨插件运行期边界**：`clis-feedback` / `clis-orchestrator` 尚不存在，§1「不决定回退」只能靠静态文本检查 + 输出结构间接验证。
2. **判定独立性**：见 §2，最终判定由实现者本人做出。
3. **5–8 层深度极值**：`max_depth` 已验到 0–4 与 8 的边界，更深链未穷举。
4. **性能与并发**：未测。

## 7. 复现命令

```powershell
# 注意：宿主重启后 PATH 中 pnpm 可能缺失，用绝对路径
$env:Path = "D:\nvm\v22.23.3;" + $env:Path
pnpm exec tsc -p tsconfig.json     # 期望 exit 0
pnpm exec vitest run               # 期望 20 文件 264 例全绿
pnpm exec vitest run tests         # 只跑独立套件（190 例）
```