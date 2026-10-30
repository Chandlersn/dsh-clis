# CLIS 介入机制在真实任务中为何没起作用

> 判据：不看单元测试，看**真实会话转录**。71 个会话 / 12 646 次工具调用 / 1 186 条真实失败，
> 按 `intervene.ts` 的闸门逻辑离线重放；`clis_run` 的真实返回逐条核对。
> 数据时间窗：2026-10-18 ~ 2026-10-30。

## 一句话结论

不是"没做好"，是**四层依次漏光**：信号进不来 → 进来了闸门不认 → 认了提示不匹配 → 匹配了用了也没用。
最致命的是第四层——`clis_run` 在真实任务里 4/4 都返回 `manual_intervention`，等于告诉 agent"这条走不通"。

**2026-10-30 已按本文顺序修复六处**，见文末「修复落地与实测」。

---

## 第一层：信号进不来（已修 2 处）

| 缺陷 | 实测量 | 状态 |
|---|---|---|
| 监听器从未注册 | 宿主事件在 `ctx.on`；`ctx.tools.on` 不存在。旧代码 `if (ctx.tools.on === undefined) return` 直接静默返回 | **已修**（工作区未提交） |
| 非零退出码被报成成功 | 宿主 shell 工具 `isError=false`、退出码在 `value.exitCode`。1 186 条真实失败里 **694 条（58%）** 走这条路 | **已修**（`exitCodeFailureOf`） |
| 注入消息缺 id | 手写 `{role,source,content}` 无 `id`，同一轮注入两条被 inbox 按 id 去重拒绝 | **已修**（`createInjectedMessage`） |

修前：`hinted` 恒 0（`clis-interventions.jsonl` 里 10-26 ~ 10-30 无任何 hinted 行）。
修后：真机已落账，含 `pwsh:exit code #` 这类签名。

**测试为什么没抓到**：假 ctx 伪造了 `tools.on`，692 例全绿把"监听器从未注册"藏了两周。
已改成忠实于宿主的替身（事件在 `ctx.on`，`tools` 服务无 `on`）。

---

## 第二层：进来了，闸门不认（未修）

闸门条件：**2 分钟窗口内 + 同一签名 ≥2 次**。

| 指标 | 实测 |
|---|---|
| 真实失败总数 | 1 186 |
| 修后闸门触发 | **41 次（3.5%）** |
| 相邻同签名失败对的间隔 | ≤2 分钟 108（**39.7%**）/ 2–10 分钟 61 / >10 分钟 103 |
| 若放宽到"同工具任意失败 ≥2 次" | 164 次（4 倍） |

签名把数字归一成 `#`，但对 `pwsh` 这种工具，正文里混着 stdout/stderr/进度条，
**同一个根因常常算出不同签名**，于是"重复"永远凑不够 2 次。

---

## 第三层：触发了，但提示不匹配（未修）

41 次触发按失败性质拆开：

| 类别 | 次数 | 占比 | 举例 |
|---|---|---|---|
| INFRA 设施型 | 15 | 37% | `Auto review of tool "pwsh" failed`、`web fetch failed`、`tool returned invalid output` |
| SEM 语义型 | 17 | 41% | 测试失败、构建失败、脚本逻辑错 |
| MECH 机械型 | 9 | 22% | `file has not been read`、`old_string was not found`、`invalid arguments` |

而提示文案说的是"回路会越修越弹、对偶会一边修一边被拉回去"——
对 `old_string was not found` 这类"先读文件再改"的机械错误，这句话既不对题也不可执行。

**真正属于因果结构判断该管的（SEM）只有 17 次，占全部 1 186 条失败的 1.4%。**

---

## 第四层：用了也没用（最致命，未修）

`clis_run` 的 13 次真实调用：

| outcome | 次数 | 说明 |
|---|---|---|
| `manual_intervention` | 7 | 真实任务 **4/4** 全是这个结局 |
| `effective` | 6 | 全部是"调价抑制需求"这类合成验证用例 |
| 报错 | 1 | `storageDomain` / `lossless JSON`（已修） |

**根因**：`orchestrator/service.ts:147` 的早退判据

```ts
const noChangeAtAll = !producedChange && observedOnly > 0 && blockedSteps > 0;
```

`SemiAutoExecutor` 把只读动作标 `observationOnly: true` → 记成 `observed_only`；
写动作被拦才记 `failed`。于是一条**纯只读路径**（`partition_sub_modules → probe_environment → observe_response`）
满足 `observedOnly>0` 却 `blockedSteps===0`，早退不触发 → 落到 `decide()` 判 `ineffective` →
`switch_path` 换到另一条同样纯只读的路径 → 绕满 rollback 上限 3 次（实测 7 轮）才返回
`manual_intervention`。

而 13 次真实调用**没有一次传 `allow_writes`**——没有 agent 会想到去授权，
它只看到"CLIS 说这条路走不通，需人工介入"。

`clis-history` 侧证：11 个问题 / 13 条记录，**11 条是 baseline、0 条 achieved**，
唯一有 3 条记录的那个问题，三条全是 `ineffective` / `type_misjudged`。

---

## 第五层（度量）：采用率是假象

`clis_metrics` 报 0.83 采用率。但 `adopted` 是独立计数，**不条件于此前的 hinted**：

```
07:04:41  adopted clis_classify  ← 此前 hinted: 0
07:13:57  adopted clis_classify  ← 此前 hinted: 1
```

5 次 adopted 里 1 次此前零提示——它只是"这个 agent 调了 CLIS"，不是"提示被采纳"。
分母 6、分子 5 的巧合让数字看起来健康，实际样本量根本不足以支撑结论。

---

## 第六层（覆盖）：子 agent 是盲区

| delegationDepth | 会话 | 可见请求 | clis 调用 | 使用率 |
|---|---|---|---|---|
| 0（主 agent） | 25 | 172 | 48 | 27.9% |
| 1（子 agent） | 46 | 27 | **0** | **0%** |

46 个子 agent 会话里只有 27 次请求能看见 clis 工具，**一次都没调用**。
子 agent 恰恰是跑测试、跑构建、反复失败最多的那一层——介入最该到的地方，一个人都没有。

---

## 建议修复顺序（按性价比）

1. **`clis_run` 纯只读早退**（`service.ts:147`）：去掉 `blockedSteps > 0` 的要求，
   改成"没有任何步骤真的改了东西"就早退。这一条能让 4/4 的 dead end 变成一次有信息的返回。
2. **默认放行只读路径的收尾**：只读路径跑完就该返回"这是观测计划 + 需要你采集什么"，
   而不是判 `ineffective` 再换路径空转。
3. **闸门相关性**：先判失败类别，只对 SEM 类介入；MECH/INFRA 类直接沉默
   （它们有更好的处理方式：重读文件、重试网络）。
4. **窗口放宽 + 签名降噪**：2 分钟 → 10 分钟（覆盖从 39.7% 升到 62%）；
   签名剥掉 stdout/stderr 噪音，只留错误首行。
5. **提示文案分支**：按失败类别给不同的话，而不是一律"回路/对偶/单向"。
6. **度量口径**：`adopted` 必须条件于"该 agent 在此前 N 分钟内有 hinted"。
7. **子 agent 覆盖**：确认 clis 工具为何在子 agent 请求里只有 27/60 可见。

---

## 修复落地与实测（2026-10-30）

前六条已全部实现并验证；第 7 条（子 agent 覆盖）是宿主侧的工具可见性问题，未动。

| # | 修复 | 位置 | 判据 |
|---|---|---|---|
| 1+2 | 纯只读路径早退；两种结局两套话术 | `clis-orchestrator/src/service.ts` | 真机 `nested` 从 7 轮/rollback 3 → **1 轮/rollback 0** |
| 3 | 失败性质分类（MECH/INFRA/SEM），只对 SEM 介入 | `clis-plugin/src/failure-kind.ts`（新增） | 真实转录回放：触发 **100% 为 SEM**（旧闸门 59% 无关） |
| 4 | 窗口 2→10 分钟；签名取代表行 | `clis-plugin/src/intervene.ts` | 相邻同签名失败对覆盖 39.7% → 62% |
| 5 | 提示语气分级 `repeated` / `escalating` | `clis-plugin/src/intervene.ts` | 第 2 次给"重复"，第 3 次给"该怀疑假设" |
| 6 | `adopted` 条件于此前的 `hinted`；无前提的记 `spontaneous` | `clis-plugin/src/intervene-metrics.ts` | 真机 `clis_metrics` 已输出 `spontaneous: 1` |

**真实转录对照**（同一批 71 会话 / 1 208 条失败）：

| 口径 | 旧闸门 | 新闸门 |
|---|---|---|
| 触发次数 | 41 | 48 |
| 其中与因果结构无关 | 24（59%） | **0** |
| 在 SEM 失败上的触发率 | — | 6.8% |

**验证方式**（避免"全绿只证明没坏"）：

- 新增 `tests/pure-observation-path.test.ts`：把判据临时改回旧版，**3 个用例立刻变红**，
  确认它们真的能抓到该缺陷；恢复后 8 例全绿。
- 新增 `tests/failure-kind.test.ts`：33 例，逐条用**真实会话里出现过的失败原文**断言分类。
- 全量 52 文件 / 775 例全绿；`tsc` 0 错；七道部署闸门全过。
- 真机验证需**重启宿主**（热重载只换装包根入口，四个组件的独立 fiber 不换），
  重启后 PID 6460 → 39180，行为差异如上表。

---

## 附：方法可复用

会话转录 `session.v4.jsonl.zstd` 是**多帧拼接**的 zstd 流（每 append 一帧）。
Node 的 `createZstdDecompress` 只解第一帧，必须按魔数 `28 B5 2F FD` 切帧逐帧解压。
解码后的 `tool/call` + `tool/result` 可完整还原失败事件流，是复算闸门、验证介入有效性的唯一真实数据源。
