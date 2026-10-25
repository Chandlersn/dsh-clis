# clis-classifier 独立验收报告

| 项目 | 值 |
| --- | --- |
| 验证者 | `clis-verifier`（独立验证，非实现者） |
| 被验对象 | `packages/clis-classifier/src/**`（`index.ts` / `rules.ts` / `service.ts`） |
| 权威规格 | `docs/SPEC-classifier.md`（FROZEN，2026-10-25） |
| 验收套件 | `tests/**`（验证方作用域，6 个测试文件 + 1 个工具文件，105 条用例） |
| 执行环境 | Windows / Node ≥22 / vitest 5.0.5 / TypeScript 5.9.3，workdir `D:\个人开发\CLIS` |
| 执行时间 | 2026-10-25 12:43–13:17（Asia/Shanghai） |
| **结论** | **PASS** —— `tsc` exit 0，全仓 `vitest run` 10 文件 145 用例全绿；SPEC §6「验证方」12 项逐项 PASS；对抗性与反例构造未发现实现与 SPEC 的实质冲突 |

> 本报告只记录**我自己实际执行**的命令与输出；Lead 转述的数字（133 全绿等）另行复核，复核结果一致但以本报告实测为准。

---

## 1. 验收命令与实测结果

```
D:\个人开发\CLIS> pnpm exec tsc -p tsconfig.json
TSC_EXIT=0

D:\个人开发\CLIS> pnpm exec vitest run
 Test Files  10 passed (10)
      Tests  145 passed (145)
VITEST_ALL_EXIT=0
```

只跑验证方套件：

```
D:\个人开发\CLIS> pnpm exec vitest run tests
 Test Files  5 passed (5)      ← 首轮冻结版本（尚未追加 adversarial 文件）
      Tests  93 passed (93)
VITEST_TESTS_EXIT=0
```

失败明细：**无失败项**（0 failed / 0 skipped / 0 todo）。全量 145 例的构成：

| 文件 | 用例数 | 归属 |
| --- | --- | --- |
| `tests/classifier-rules.test.ts` | 19 | 验证方 |
| `tests/classifier-invariants.test.ts` | 25 | 验证方 |
| `tests/classifier-malformed.test.ts` | 34 | 验证方 |
| `tests/classifier-responsibility.test.ts` | 5 | 验证方 |
| `tests/classifier-e2e.test.ts` | 10 | 验证方 |
| `tests/classifier-adversarial.test.ts` | 12 | 验证方（追加，见 §4） |
| `packages/clis-classifier/test/*`（3 文件） | 38 | 实现方（仅记录"全绿"事实，未核对断言与 SPEC 的一致性） |
| `packages/clis-contracts/test/cordis-augmentation.test.ts` | 2 | Lead |

## 2. 交付物与冻结哈希（SHA256 前 16 位）

| 文件 | 字节 | mtime | SHA256(16) |
| --- | --- | --- | --- |
| `tests/helpers.ts` | 11917 | 12:02:41 | `301A9A5F3B6F872C` |
| `tests/classifier-rules.test.ts` | 11793 | 12:04:19 | `CB0FC5F78801294B` |
| `tests/classifier-invariants.test.ts` | 18546 | 12:19:57 | `C3D273E61F146D08` |
| `tests/classifier-malformed.test.ts` | 9344 | 12:22:10 | `2A2F3B3A9F546140` |
| `tests/classifier-responsibility.test.ts` | 5718 | 12:28:42 | `F57DF8EEC1DFED05` |
| `tests/classifier-e2e.test.ts` | 5999 | 12:38:16 | `F37755EC5B1BDCBD` |
| `tests/classifier-adversarial.test.ts`（追加） | 11214 | 12:58:42 | `7A8A7CB11CBE518F` |

被验实现（只读，供回溯，**验证方未修改**）：

| 文件 | 字节 | mtime | SHA256(16) |
| --- | --- | --- | --- |
| `packages/clis-classifier/src/index.ts` | 773 | 11:56:43 | `3EF51AC425480A4D` |
| `packages/clis-classifier/src/rules.ts` | 16076 | 11:54:29 | `A4FBB20C478E944E` |
| `packages/clis-classifier/src/service.ts` | 970 | 11:55:36 | `B87E6EE00457E76C` |

写作用域纪律：`git status --porcelain` 显示本验证者只动过 `tests/**`（追加文件仍是 untracked），未触碰 `packages/**`、`docs/**`、根配置。首轮 5 个套件文件 + `helpers.ts` 已被 Lead 的提交 `3f5b649` 纳入；**`tests/classifier-adversarial.test.ts` 目前未提交**，请 Lead 决定是否一并提交。

## 3. 独立性披露（如实，请原样转述）

**结论：套件的全部行为期望来自 SPEC 与契约，写作期间我没有读过 `packages/clis-classifier/src/**`；但实现落盘于我开始写套件之前，因此本报告的证据强度是"规格先行、实现盲写"，不是"实现与套件互盲"。**

可核验的时点关系：

| 时点 | 事件 | 证据 |
| --- | --- | --- |
| 11:34:59 | 我 glob `packages/clis-classifier/**`，`src/` **尚不存在**（只有 `package.json` 与 `node_modules/.bin/cordis*`） | 会话内工具输出 |
| 11:52:23 / 11:55:36 / 11:56:43 | 实现三文件落盘（`rules.ts` / `service.ts` / `index.ts`） | 文件系统创建时间 |
| 12:02:41–12:38:16 | 我逐个写套件文件（顺序：helpers → rules → invariants → malformed → responsibility → e2e） | mtime 表（§2） |
| 12:43:47 | **首次**运行套件：5 文件 93 例，一次全绿 | 命令输出 |
| 12:45:02 | 全仓 9 文件 133 例全绿；随后计算并记录套件哈希（**冻结**） | 命令输出 + §2 |
| 约 13:00–13:05 | **首次**阅读 `packages/clis-classifier/src/**`（3 个文件全文），仅用于本报告 §6 的对抗性复核 | 会话内 read 调用 |
| 12:58:42 / 13:02 / 13:03 / 13:17 | 追加 `classifier-adversarial.test.ts` 12 例 → 全绿 → 全仓 145 例全绿 → 终局复跑 | 命令输出 |

因此：

1. **期望值来源**：`tests/helpers.ts` 内的预言机 `expectedOutcome()`（类型、`0.9 - 0.08·unknownCount - (R3?0.15:0)`、`needs_exploration = confidence < 0.7`）与全部数值断言，均按 SPEC §4/§4.1 与契约 `FOUR_QUESTIONS` / `KNOWN_CAUSAL_TYPES` 写成，未参考实现。
2. **一处可供检验的先验证据**：SPEC §4.1 的公式与同节表格在 R4 上相互矛盾（见 §7 N-4）。我按**表格**取 `0.4 / 0.25`，该取值在 `tests/helpers.ts`（12:02:41，`301A9A5F3B6F872C`）中即已固化，**早于我首次阅读实现约 1 小时**；若该期望是从实现反推，就不可能同时存在这个"公式导不出、只有表能导出"的取值。
3. **授权例外**：`tests/classifier-responsibility.test.ts` 依 SPEC §6-12 明确授权读取 `src/**` 文本做静态断言；该文件**在运行时**由测试代码读取源码（12:43 起），我没有把源码内容用于构造任何行为期望。该文件另含 5 条中的 1 条"检查器自检"用例，专门防止静态检查在无源码时空转变绿。
4. **残余局限**：实现（11:52–11:56）早于我的套件（12:02–12:38）落盘，且实现由 Lead 本人完成。我无法证明 Lead 未见过我的测试，也无法证明实现未受我未落盘的中间稿影响；我只能保证**我没有反向依赖实现**。若要更强的独立证据，需在套件冻结后由第三方重跑并核验 §2 哈希 —— 哈希已给出。

## 4. 冻结后的**追加**（只增不改，可核对）

首轮 5 文件 93 例全绿后，我复核 SPEC §4.3/R9 覆盖面时发现自己漏了一类：**R9 对 R3 根同样适用**（原套件的嵌套用例全部以 `Q4=yes`（R1）为根）。按任务「反例优先」要求，我**追加**了 `tests/classifier-adversarial.test.ts`（12 例），未修改任何既有断言 —— §2 表中前 6 个文件的哈希与 12:02–12:38 记录完全一致可证。追加内容：

- **A：R9 适用于 R3 根** —— `Q4=no, Q1=yes, Q2=yes`（R3，根 `confidence=0.75`）带 2 个子问题 ⇒ `sub_modules` 长度 2、`name=sub-1/sub-2`、子类型 `cyclic`/`nested`、孙层继续递归、SUBMODULE 证据 1 条（statement 含 `2`/`sub-1`/`sub-2`）、末尾主判据仍指 R3、RULE 证据恰 2 条且末条 `weight=0.75`。
- **B：两个子问题各自又是嵌套** ⇒ 根 2 个子模块均 `nested`，各自再拆 1 层且**逐层 `name` 均从 `sub-1` 重新编号**（§4.3 `i` 每次从 0 起），递归层不变量全部成立；另有单层对照用例防"构造掩盖基线"。
- **C：`max_depth` 切断点精确落在边界** —— 4 层链 root(0)→A(1)→B(2)→C(3)→D(4)：`max_depth=3` ⇒ C 的 `sub_modules = []`（D 不出现）；`max_depth=4` ⇒ C 含 1 个 `structural_duality` 子模块；`max_depth=2` ⇒ depth 2 节点切断、depth 1 节点仍下探；`max_depth=0` ⇒ 仅根结论。
- **D：非典型路径的交叉不变量** —— `Q4=yes 且 Q1..Q3 全 no`（无候选假设、有 `sub_modules`、R1 fired / R3 not fired）；R2 根即使带 `sub_problems` 也不得产出 `sub_modules`；递归到 R4 子问题仍给 4 条候选且 evidence 非空。

## 5. SPEC §6「验证方」12 项逐项核对

| # | SPEC 要求 | 判定 | 证据（断言名 / 命令输出） |
| --- | --- | --- | --- |
| 1 | 任意输入 `0 < confidence <= 0.9`，永不等于 1.0 | **PASS** | `classifier-invariants.test.ts`：〈SPEC §6-1 / §4 全矩阵（3^4 = 81 组）预言机扫描〉逐组比对类型/置信度/探索模式并校验不变量；〈陪伴矩阵：同一批作答下 confidence 恒 ∈ (0, 0.9] 且永不等于 1.0〉；`classifier-responsibility.test.ts`：〈src 无字面量 1 / 1.0 赋值给 confidence〉 |
| 2 | 探索边界：`0.66 → true`、`0.74 → false` | **PASS** | `classifier-rules.test.ts`：〈§6-2 边界：2 个 unknown ⇒ confidence = 0.74 ⇒ needs_exploration = false〉、〈§6-2 边界：3 个 unknown ⇒ confidence = 0.66 ⇒ needs_exploration = true 且 reason 非空〉（均断言精确数值） |
| 3 | R3：`Q1=yes, Q2=yes, Q4=no ⇒ nested, 0.75` | **PASS** | `classifier-rules.test.ts`：〈§6-3 R3 冲突路径：Q1=yes, Q2=yes, Q4=no ⇒ nested 且 confidence = 0.75〉；另覆盖 d=3 同为 0.75、R3+1 unknown=0.67 |
| 4 | `needs_exploration=true ⇒ reason 非空`；`false ⇒ 该字段不存在` | **PASS** | 双向断言由 `helpers.ts` 的 `invariantViolations()` 在 81 组 ×（无子问题 / 有子问题）+ 递归层强制执行一次不落；另见 rules 各用例的 `expect(result.exploration_reason).toBeUndefined()` |
| 5 | `unknown ⇒ candidate_hypotheses` 四类齐全降序；非 unknown ⇒ 无 | **PASS** | `classifier-rules.test.ts`：〈四问全 no ⇒ … 候选四类各 0.3 且保持 KNOWN 顺序〉（`toStrictEqual([...KNOWN_CAUSAL_TYPES])` + `[0.3,0.3,0.3,0.3]`）、〈含 unknown ⇒ … 各 0.2 且保持 KNOWN 顺序〉、〈非 unknown 结论 ⇒ candidate_hypotheses 必须不存在〉（5 组代表性输入） |
| 6 | `nested ⇒ 有 sub_modules`；非 nested ⇒ 无 | **PASS** | `classifier-invariants.test.ts`：〈nested 但无 sub_problems ⇒ sub_modules = []（字段必须存在）〉、〈非 nested 结论 ⇒ sub_modules 必须不存在（undefined）〉（遍历全部 81 组并附 `sub_problems`） |
| 7 | 2 个子问题（cyclic + unidirectional）⇒ 长度 2、类型正确 | **PASS** | `classifier-invariants.test.ts`：〈§6-7 两个子问题（cyclic + unidirectional）⇒ sub_modules 长度 2 且类型各自正确〉（含 `name=sub-1/sub-2`、子层 evidence 非空、`confidence=0.9`） |
| 8 | `max_depth = 0` 且根 nested ⇒ `sub_modules = []` | **PASS** | `classifier-invariants.test.ts`：〈§6-8 max_depth = 0 且根为 nested ⇒ sub_modules = []（不校验也不下探）〉；`classifier-adversarial.test.ts`：〈max_depth = 0 时第 1 层子问题完全不出现在输出中〉 |
| 9 | 畸形输入 ⇒ `ClisContractError` 且 code 正确 | **PASS** | `classifier-malformed.test.ts` 34 例：30 条畸形（缺字段 / 非对象 / 非法三态值（`maybe`、`YES`、`true`、`''`、`null`）/ `max_depth = -1, 99, 8.5, 1.5, "3", true, NaN` / 子问题与孙问题畸形）逐条断言 `code`、`name`、`message` 非空、`details` 字段级 `path/expected/received`；另有 4 条"合法边界不得误报" |
| 10 | 确定性：同输入两次深度相等 | **PASS** | `classifier-invariants.test.ts`：〈同一输入连续两次 classifyProblem 结果深度相等（toStrictEqual）〉（4 类输入，含嵌套）、〈classifyProblem 是纯函数：不修改入参（调用后与快照深度相等）〉（`structuredClone` 快照比对） |
| 11 | 真实 Cordis `Context` 装载 ⇒ 服务结论与纯函数一致 | **PASS** | `classifier-e2e.test.ts` 10 例：`new Context()` + `await ctx.plugin(classifierPlugin)` → `ctx['clis.causalClassifier']` → `await classify(...)`，与 `classifyProblem()` 做 `toStrictEqual`（基础、嵌套、`max_depth` 透传三种输入）；另含 `ctx.inject([...], cb)` 取服务路径、畸形输入 `rejects.toBeInstanceOf(ClisContractError)`、两个独立 Context 结论一致 |
| 12 | 静态边界检查：无 strategy/feedback/orchestrator import；无 `confidence` 字面量 `1.0/1` 赋值 | **PASS** | `classifier-responsibility.test.ts` 5 例：扫描 `src/**` 3 个文件，import 说明符集合为空违规、`@clis/*` 仅 `@clis/clis-contracts`、无 `confidence: 1/1.0` 字面量赋值；第 5 例是**检查器自检**（能识别静态/动态 import 与 `confidence: 1`，且不误伤 `confidence: 0.15`、`Math.min(raw, 0.9)` 与注释中的包名），确保前 4 例不是空转 |

**实现方作用域未越界**：`git status` 无 `packages/**` 变更；SPEC §6-12 静态检查通过；我未修改任何实现文件。

## 6. 对抗性检查（我实际验证过的项与结论）

| 检查项 | 构造输入 | 实测结论 |
| --- | --- | --- |
| 置信度下限边界 `0.74` | `Q1=yes, Q2=unknown, Q3=no, Q4=unknown` | `structural_duality`，`confidence === 0.74`，`needs_exploration === false`（严格 `< 0.7`，未用 `<=`） |
| 置信度下限边界 `0.66` | `Q1=yes, Q2/Q3/Q4=unknown` | `structural_duality`，`confidence === 0.66`，`needs_exploration === true`，`exploration_reason` 非空 |
| 上限封顶 | 全矩阵 81 组 + 递归层 | 最大观测值 `0.9`，无一例 `> 0.9`，无一例 `=== 1`（静态检查亦无 `confidence: 1` 字面量） |
| R3 冲突路径 | `Q1=yes, Q2=yes, Q3=no, Q4=no` | `nested`，`confidence === 0.75`，R3/R6 fired，R2 not fired，RULE 证据 2 条（冲突条 + 末尾主判据 `weight = 0.75`） |
| R3 扣分只扣一次 | `Q1=Q2=Q3=yes, Q4=no`（d=3） | 仍 `0.75`（非 0.6），证明 R6 按"触发与否"扣一次而非按冲突类型数 |
| R3 + 1 unknown | `Q1=yes, Q2=yes, Q3=unknown, Q4=no` | `0.67`，`needs_exploration === true` |
| R1 优先级高于 R3 | `Q4=yes` 且 `Q1..Q3` 全 `yes` | `nested`，`0.9`（未误扣 0.15），R3 **not fired**，RULE 证据恰 1 条 |
| `max_depth` 超限 | `max_depth` ∈ {-1, 99, 8.5, 1.5, `"3"`, `true`, `NaN`} | 全部 `ClisContractError` + `INVALID_OPTIONS`，`details[].path` 含 `max_depth`；边界值 `{0,1,3,8}` 均不误报 |
| `max_depth` 精确切断 | 4 层链 + `max_depth ∈ {0,1,2,3,4,8}` | 与 `depth + 1 > max_depth` 逐点一致（见 §4 C），且不改变根自身判据（恒 nested/0.9） |
| 畸形输入错误码 | 30 条（含策略性构造：`answers` 缺单字段、三态值大小写、子/孙层畸形） | 错误码与 SPEC §3 表逐条一致；`details` 均字段级且 `path` 非空，命中字段名（`description`/`sub_problems`/`label`/`answers`/`q1`/`q2_delayed_mutual_influence`/`q3`/`q4`/`max_depth`） |
| evidence 恒非空 | 81 组 + 递归层 + R4 全 no 空描述 | 每组至少 1 条；每条 `statement` 非空、`weight ∈ [0,1]`；末尾恒为 RULE 主判据且 `weight === confidence` |
| `unknown` 候选假设 | R4 两分支 + 递归层内的 R4 子问题 | 恰好 4 条、类型序列 `toStrictEqual(KNOWN_CAUSAL_TYPES)`（同分稳定降序）、`rationale` 非空、分值 `[0.3×4]` / `[0.2×4]` |
| 非 unknown 的无候选 | 5 组代表性 + 81 组 | 全部 `undefined`（`toStrictEqual`/`toBeUndefined`，非 truthy 判断） |
| 服务层不兜底 | 服务 + 缺字段 / `max_depth=-1` / `99` | Promise **reject** 为 `ClisContractError`，未返回任何兜底结论 |

## 7. 发现（**无硬性 FAIL**；以下 5 条为非阻塞规格瑕疵 / 未规定项，均已实测复现）

**N-1（非阻塞·规格歧义）`description` 仅含空白字符时不产出描述证据。**
实测：`{description: '   ', answers: 四问全 no}` ⇒ `evidence` 长度 5（4 条作答状态 + 1 条主判据），`DESCRIPTION` 来源证据数 **0**。
规格文字（§5）："`description` 非空时再给出一条描述证据" —— 字面读法下 `'   '` 是非空字符串，应有 1 条；实现取 `description.trim().length > 0`。
复现：`classifierPlugin.classifyProblem(makeProblem('no','no','no','no',{description:'   '}))`。
处置建议：Lead 二选一 —— ① 明确"非空"含空白并改实现判定；② 把 SPEC 措辞改为"含非空白字符"。我**未**为此加断言（规格歧义不足以判 FAIL）。

**N-2（非阻塞·SPEC 未规定）`problem` 与 `options` 同时畸形时的错误码优先级。**
实测：`{description: 5, ...}, {max_depth: -1}` ⇒ **`INVALID_OPTIONS`**（实现先校验 options，后校验 problem）。SPEC §3 未规定优先级。
复现：`classifierPlugin.classifyProblem({description:5, answers:VALID}, {max_depth:-1})`。

**N-3（非阻塞·SPEC 未规定）`max_depth = 0` 时不产出 `SUBMODULE` 证据。**
实测：`R9.fired=false`、`R10.fired=true`、`SUBMODULE` 证据数 0。§4.3 只说"拆分发生时追加"，未拆分则无证据属合理读法，但 SPEC 未明写；我刻意未断言其"不存在"以免过度规定。

**N-4（**规格内部矛盾**，建议 Lead 裁决）§4.1 公式与同节表格在 R4 上互相冲突。**
§4.1 正文：`confidence = normalizeConfidence(0.9 - 0.08·unknownCount - (R3?0.15:0))`；按此公式，R4 全 `no` 应得 `0.9`、含 1 个 `unknown` 应得 `0.82`；但同节表格明列「R4，四问全 `no` ⇒ **0.4**」「R4，含至少一个 `unknown` ⇒ **0.25**」。
实现按**表格**（`UNKNOWN_ALL_NO_CONFIDENCE=0.4` / `UNKNOWN_INCOMPLETE_CONFIDENCE=0.25`），我的套件同样按**表格**断言（该先验固化于 12:02 的 `helpers.ts`，见 §3-2）。二者一致，故判 PASS；但 SPEC 文字层面的冲突**应修**，否则后续实现者按公式写会与验收套件冲突。
复现：`classifyProblem(makeProblem('no','no','no','no')).confidence === 0.4`（对照公式预期 0.9）。

**N-5（非阻塞·实现附加严格性，方向安全）**
`options` 本身非对象（`null`）⇒ `INVALID_OPTIONS`；`max_depth: null` ⇒ `INVALID_OPTIONS`；整棵子树**急切校验**（根非 nested、或 `max_depth=0` 不递归时，深层畸形子问题仍抛 `INVALID_ANSWERS`）。均与 §3 的无条件输入校验相容，SPEC 未逐条规定；记录以备契约收紧时统一。

## 8. 本轮**无法验证**的部分

1. **跨插件运行时边界**：`@clis/clis-strategy` / `clis-feedback` / `clis-orchestrator` 在本仓库不存在，§1「不生成策略 / 不执行 / 不回退」只能靠静态文本检查（§6-12）+ 输出结构（无 strategy/action/rollback 字段）间接验证，无法做跨插件动态插桩证明。
2. **SPEC 引号内文案的逐字一致**：§4.1 R4 的两句 `exploration_reason` 说明、§5 描述证据与 R3 冲突证据的措辞，我只验证"存在且非空 / 含关键数字与名字"，未逐字比对；同义改写是否合规需 Lead 认定。
3. **更深层的深度上限**：只验到 4 层链与 `max_depth ∈ {0,1,2,3,4,8}`；未构造 5–8 层完整链，`MAX_DEPTH_LIMIT=8` 的极值路径未全展开验证。
4. **文本边角**：`description` 超长已验（200 字符 → 120 + `…`），但含 emoji / 代理对（UTF-16 码元 vs 码点计数）、`label` 超长或含空白、`description` 恰好 120/121 字符的边界未验证；SPEC 未定义"字符"的口径。
5. **随机/穷举之外的数值**：置信度只覆盖 §4.1 表出现的取值与 81 组矩阵；未做属性化随机模糊测试（`3^4` 已穷举作答空间，但 `sub_problems` 树形未穷举）。
6. **包内单测一致性**：`packages/clis-classifier/test/**` 38 例全绿仅作事实记录；其断言是否与 SPEC 一致属实现方作用域，我未复核（抽查会破坏"验证方不读实现单测"的分工）。
7. **Cordis 生命周期**：`ctx.plugin` 卸载/`fiber` 释放后服务是否随之消失、重复装载幂等性 —— SPEC 未规定，未验证。
8. **环境面**：按纪律未运行 `pnpm install`，故未验证冷安装、CI、跨 Node 版本（≥22 声明）、并发/性能；`pnpm-lock.yaml` 与 `node_modules` 由 Lead 持有。
9. **首轮"实现未交付"的预期红灯**未实际观察到：我写完套件时实现已在盘（11:52–11:56），12:43 首跑即 93 例全绿；因此"套件在无实现时确实会红（而非空转变绿）"这一点**未被验证**——只有 `classifier-responsibility.test.ts` 的检查器自检用例部分缓解该风险。

## 9. 复现命令

```powershell
# 在 D:\个人开发\CLIS 下
pnpm exec tsc -p tsconfig.json                 # 期望 exit 0
pnpm exec vitest run                           # 期望 10 文件 145 例全绿
pnpm exec vitest run tests                     # 只跑验证方套件（105 例）
pnpm exec vitest run tests/classifier-invariants.test.ts
pnpm exec vitest run tests/classifier-malformed.test.ts
pnpm exec vitest run tests/classifier-responsibility.test.ts
pnpm exec vitest run tests/classifier-e2e.test.ts
pnpm exec vitest run tests/classifier-adversarial.test.ts

# 最小复现（N-1 空白描述）
#   classifierPlugin.classifyProblem({description:'   ', answers:{四问全 'no'}})
#   → evidence 长度 5，DESCRIPTION 证据 0 条
# 最小复现（N-4 R4 置信度）
#   classifierPlugin.classifyProblem({description:'', answers:{四问全 'no'}}).confidence → 0.4
```

> 未修改任何断言以求绿，未修改 `packages/**`；所有失败/歧义项如上如实列出。