# CLIS · 因果分层智能系统

[English](README.en.md) | 中文

一个 DSH（DeepSeek Harness）插件。它做两件事：

**一是让 agent 在碰到问题和反馈时介入。** agent 不改变最初的想法；
当失败开始重复出现（同类工具失败 ≥2 次），CLIS 在结果进入模型前注入
一条结构判断提示——这个失败模式可能不是单点故障，而是回路（越修越弹）、
对偶（一边修一边被拉回）或单向（该追溯最早的因）。判错方向，努力白费。
提不提示有四道闸门控制：只盯失败、窗口计数、冷却去重、额度沉默——
不干扰，又能起作用。**它有没有用是可测的**：`clis_metrics` 报告
"提示注入了多少次、agent 采纳了多少次"。

**二是让全系统插件互相看得见健康。** 枚举宿主全部插件、收集各自的健康
探针，把散乱的警告归并成结构结论（"这 5 条警告是同一个反馈环的不同切面，
逐条修会失败"）。自动层零配合覆盖全部非内建插件；任何插件导出一个
`healthProbe` 即可接入更深的领域信号。

诚实声明：因果分类是**确定性规则打分**（调用方需先填四问），不是语义理解；
策略路径与归因主张**没有对照实验支撑**——测试证明的是工程严谨，不是
"比直接处理更有效"。监督与介入层有真机实证。详见
[reports/open-source-readiness.md](reports/open-source-readiness.md)。

## 目录

```
packages/clis-contracts/    共享契约（类型 + 四问 + 服务接口，无判定逻辑）
packages/clis-classifier/   因果类型分类器
packages/clis-strategy/     策略匹配、路径生成与排序、执行
packages/clis-feedback/     反馈信号与误判识别
packages/clis-orchestrator/ 编排与回退决策
packages/clis-plugin/       插件入口：agent 工具 + 系统提示段 + 监督探针
packaging/                  可安装产物的手写资产（patch / package.json / icon / README / locale）
docs/                       冻结规格 + 插件封装标准 + 安装指南
scripts/                    构建（bundle / package）、冒烟、一键部署
tests/                      跨包黑盒验收与端到端
reports/                    验证报告与开源就绪度评估
```

## 四个组件与硬约束

四个组件按固定顺序协作，彼此**只依赖共享契约包**，不互相 import 实现：

| 组件 | 职责 | 输出 |
| --- | --- | --- |
| `clis-classifier` | 只做因果类型判断 | `CausalClassification` |
| `clis-strategy` | 只做策略匹配、候选路径生成、排序与执行 | `CandidatePath[]` / `ExecutionResult` |
| `clis-feedback` | 只检测反馈信号类型 | `FeedbackSignal` |
| `clis-orchestrator` | 只编排调用与回退决策 | 闭环控制 |

1. **生成与判断分离**：classifier 不评价策略，strategy 不重新分类，feedback 不自动回退。
2. **回退由 orchestrator 执行**：feedback 只输出信号与建议。
3. **契约先行**：只依赖 `@clis/clis-contracts`，不互相 import 实现文件。
4. **置信度上限 0.9**；低于 0.7 必须标记探索模式。
5. **回退上限默认 3 次**，超限输出「需人工介入」并记录完整 trace。
6. **同一类型连续被回退时锁定至少 1 轮**再允许再次回退。
7. **回路判据只认跨轮**：同一规则在一轮内触发多次不算回路。

## 因果类型

- `structural_duality`：A 与 B 同时成立、彼此定义、无时间先后（正与反、买与卖）
- `cyclic`：A→B→A，有时间延迟，可能振荡（供需-价格、捕食者-猎物）
- `unidirectional`：A→B，严格先后、不可逆（火→热、雨→地湿）
- `nested`：系统中同时存在多种因果结构，需拆子模块分别处理
- `unknown`：四问无法明确判断 —— 进入探索模式，不强行归类

## 必须知道的边界

1. **分类器是确定性规则打分，不解析自然语言。** 需要调用方先填好四问。
2. **执行器是半自动的**：只读动作放行，写动作默认全拦，除非 `allow_writes` 显式放行。
3. **只读模式不会空转**：整条路径只读时不判"成功"，直接返回"需授权才能推进"。
4. **强宿主耦合**：只对 DSH 用户有用，不能独立运行。

## 插件层：五个 agent 工具

| 工具 | 作用 |
| --- | --- |
| `clis_run` | 完整闭环：分类 → 匹配路径 → 执行 → 反馈 → 必要时回退 |
| `clis_classify` | 只判断因果类型 |
| `clis_plan` | 只生成并排序候选路径 |
| `clis_probe` | 系统级监督：枚举插件、收集探针、只投递结构诊断 |
| `clis_metrics` | 介入有效性：提示注入了多少次、agent 采纳了多少次 |

另注入一段系统提示段（被动提醒），并在工具失败反馈出现时**主动注入**
结构判断提示（见首屏第一件事）。

`clis_probe` 的监督分两层，**自动层零配合、覆盖全部非内建插件**；
插件模块根导出 `healthProbe` 即可接入协作层（更深的领域信号）。约定见
[docs/PLUGIN-STANDARD.md](docs/PLUGIN-STANDARD.md)。

## 技术栈

- Cordis 插件规范，`@deepseek-ai/cordis@4.0.5`（与本机 DSH 宿主同版本）
- TypeScript 5.9 strict（含 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`）
- pnpm workspace、vitest 5

## 命令

```powershell
pnpm install        # 安装依赖
pnpm run typecheck  # tsc -p tsconfig.json，期望 exit 0
pnpm run test       # vitest run，全量测试
pnpm run check      # 两条一起跑
```

构建与打包：

```powershell
node scripts/bundle.mjs       # esbuild 打包 5 个入口 → bundle/（已 gitignore）
node scripts/package.mjs      # 组装可安装产物 → dist-package/
.\scripts\deploy.ps1          # 七道闸门 + 同步 + 重启（见 -SkipRestart）
```

> `scripts/deploy.ps1` 的路径全部走参数或环境变量（`DSH_NODE_DIR`、
> `DSH_PROFILE_DIR`、`DSH_CLIS_PLUGIN_DIR`），不写死机器路径。

## 状态

| 项 | 值 |
| --- | --- |
| 测试 | 49 文件 / 692 例全绿 |
| 类型检查 | `tsc` exit 0 |
| 硬约束验证 | 7 条全 PASS |
| 独立验收 | 四组件全覆盖——orchestrator 由独立方只读规格写 60 条断言，**未发现实现违背规格**，但发现 7 处规格/契约问题（已修 2 个契约缺陷） |

验收报告：`reports/classifier-verification.md`、`reports/strategy-verification.md`、
`reports/system-verification.md`、`reports/open-source-readiness.md`（§七 为独立验收全文）。

发布流程与踩过的坑：`docs/PUBLISHING.md`。插件封装约定：`docs/PLUGIN-STANDARD.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。