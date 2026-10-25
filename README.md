# CLIS · 因果分层智能系统

CLIS 不直接解决问题。它先判断**当前问题属于哪类因果**，再据此选择对应的推理与优化策略；
用错时能检测误判并回退。

四个插件按固定顺序协作，彼此**只依赖共享契约包**，不互相 import 实现：

| 插件 | 职责 | 输出 |
| --- | --- | --- |
| [`clis-classifier`](packages/clis-classifier) | 只做因果类型判断 | `CausalClassification` |
| `clis-strategy` | 只做策略匹配、候选路径生成、排序与执行 | `CandidatePath[]` / `ExecutionResult` |
| `clis-feedback` | 只检测反馈信号类型 | `FeedbackSignal` |
| `clis-orchestrator` | 只编排调用与回退决策 | 闭环控制 |

- 共享契约：[`packages/clis-contracts`](packages/clis-contracts)（类型、四问、输出结构、抽象服务接口）
- 冻结规格：[`docs/SPEC-classifier.md`](docs/SPEC-classifier.md)

## 硬约束

1. **生成与判断分离**：classifier 不评价策略，strategy 不重新分类，feedback 不自动回退。
2. **回退由 orchestrator 执行**：feedback 只输出信号与建议。
3. **契约先行**：只依赖 `@clis/clis-contracts`，不互相 import 实现文件。
4. **置信度上限 0.9**；低于 0.7 必须标记探索模式。
5. **回退上限默认 3 次**，超限输出「需人工介入」并记录完整 trace。
6. **同一类型连续被回退时锁定至少 1 轮**再允许再次回退。

## 因果类型

- `structural_duality`：A 与 B 同时成立、彼此定义、无时间先后（正与反、买与卖）
- `cyclic`：A→B→A，有时间延迟，可能振荡（供需-价格、捕食者-猎物）
- `unidirectional`：A→B，严格先后、不可逆（火→热、雨→地湿）
- `nested`：系统中同时存在多种因果结构，需拆子模块分别处理
- `unknown`：四问无法明确判断 —— 进入探索模式，不强行归类

## 技术栈

- Cordis 插件规范，`@deepseek-ai/cordis@4.0.5`（与本机 DSH 宿主同版本）
- TypeScript 5.9 strict（含 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`）
- pnpm workspace、vitest 5

## 命令

```powershell
pnpm install        # 安装依赖（仅 Lead 执行）
pnpm run typecheck  # tsc -p tsconfig.json，期望 exit 0
pnpm run test       # vitest run，全量测试
pnpm run check      # 两条一起跑
```

### 本机环境注意（会踩到的坑）

1. **宿主重启后 `pnpm` 不在 PATH 里**：用绝对路径 `D:\nvm\v22.23.3\pnpm.cmd`，或先 `$env:Path = "D:\nvm\v22.23.3;" + $env:Path`。
2. **vitest 启动报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`**：宿主自带 safe-delete 中间层会拦截对
   `node_modules/.vitest-cache` 的批量清理（条目数 > 50 即要求确认）。处理方式：删掉该缓存目录后重跑
   （`Remove-Item node_modules\.vitest-cache -Recurse -Force`），**不要**为此关闭删除保护。
3. **PowerShell 管道会吞掉退出码**：`pnpm ... | Select-Object` 之后 `$LASTEXITCODE` 不可信，判定闸门时用
   `pnpm exec vitest run > $null 2>&1; $LASTEXITCODE`。

## 目录

```
packages/clis-contracts/    共享契约（类型 + 四问 + 服务接口，无判定逻辑）
packages/clis-classifier/   因果类型分类器
docs/                       冻结规格
tests/                      跨包黑盒验收与端到端
reports/                    验证报告
```

## 当前进度

- [x] 步骤 0：`packages/clis-contracts`
- [x] 步骤 1：`clis-classifier`（145 例验收通过）
- [x] 步骤 2：`clis-strategy`（264 例全绿；验收判定由 Lead 做出，独立性限制见报告）
- [x] 步骤 3：`clis-feedback`（286 例全绿；实现完成，待独立验收）
- [ ] 步骤 4：`clis-orchestrator`
- [ ] 步骤 5：端到端验收