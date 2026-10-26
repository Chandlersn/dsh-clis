# CLIS · 因果分层智能系统

[English](README.en.md) | 中文

DSH（DeepSeek Harness）常驻插件。**先判断问题属于哪类因果结构，再据此选择处理策略**；
用错时能检测误判并回退。

仓库里其实有**两样东西**，证据强度不同，请分开看待：

| | 系统级插件监督 | 因果推理库 |
|---|---|---|
| 是什么 | 枚举全系统插件、收集健康探针、只投递**结构判断** | 四问判因果类型 → 匹配策略 → 执行 → 反馈 → 回退 |
| 证据 | 在真实使用中被逼出来的，有可复现实证 | 602 例测试 + 7 条硬约束验证 |
| 那句测试证明的 | 能抓真问题 | **工程严谨，不是"比直接处理更有效"** |

> **因果推理层的核心主张至今没有对照实验支撑。** 602 例测试证明的是实现与规格一致，
> 不是价值。把它当作已证有效的工具使用前，请先自己验证。监督层另当别论——它抓到过
> 我本人都没预料到的问题（详见 `reports/open-source-readiness.md`）。

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

## 插件层：四个 agent 工具

`clis_run`（完整闭环）、`clis_classify`（只判类型）、`clis_plan`（只出路径）、
`clis_probe`（系统级监督）。另注入一段系统提示段。

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
| 测试 | 46 文件 / 602 例全绿 |
| 类型检查 | `tsc` exit 0 |
| 硬约束验证 | 7 条全 PASS |
| 独立验收 | classifier / strategy / feedback 较好；**orchestrator 无**（见 `reports/system-verification.md` §4） |

验收报告：`reports/classifier-verification.md`、`reports/strategy-verification.md`、
`reports/system-verification.md`、`reports/open-source-readiness.md`。

发布流程与踩过的坑：`docs/PUBLISHING.md`。插件封装约定：`docs/PLUGIN-STANDARD.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。