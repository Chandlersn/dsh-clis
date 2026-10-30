import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';

import { getCreateUserMessage } from './cordis-shim';
import { classifyFailureKind, worthCausalIntervention } from './failure-kind';
import { recordMetric } from './intervene-metrics';

/**
 * 反馈介入 —— 在 agent **碰到失败反馈的那一刻**递上一把尺子。
 *
 * ## 为什么做这个（2026-10-26 用户定位）
 *
 * CLIS 的定位不是"改变 agent 最初的想法"，而是**碰到问题和反馈时介入，
 * 帮 agent 理清归因分类，从而更好决策**。系统提示段只能被动提醒
 * （agent 得自己想起来用）；这里把它变成机制：宿主在**每个工具结果产出后、
 * 进入模型前**发 `tools/post-execute` waterfall —— 失败结果在此可见，
 * 这正是"碰到反馈"的原始信号源。
 *
 * ## 四道闸门（不干扰又起作用的关键）
 *
 * 1. **信号**：盯**两类失败**——`isError === true` 的真错误，以及宿主
 *    shell 类工具报成成功的**非零退出码**（`isError=false` 但
 *    `value.exitCode !== 0`）。第二类是必需补充：宿主把"命令跑失败"报成
 *    成功结果（源码注释："Non-zero exits are reported, not errored"），
 *    只盯 isError 的话，最常见的真实失败永远到不了闸门。退出码为 0 的
 *    成功一律跳过——此时插话是纯干扰。第一版刻意不盯"重复调用"——幂等工具
 *    （读文件、查状态）连续跑两次是正常操作，误报成本高于漏报。
 * 2. **预筛**：失败 1 次不值得介入（谁都偶有失败）。判定规则是
 *    **2 分钟窗口内同一工具失败 ≥2 次**。窗口按工具名分桶，互不影响。
 * 3. **抑制**：同一 agent 冷却期内最多提醒 1 次；同一 signature 只提醒 1 次，
 *    直到它真正调用了 `clis_run`（说明提示被听进去了，之后是它的选择）。
 *    这两条合起来，把"每个失败都唠叨"降为"偶尔递一次尺子"。
 * 4. **预算**：判定必须同步、零 I/O（内存滑动窗口），注入内容是常量字符串。
 *    没有慢路径，失败模式只能是沉默。
 *
 * ## 注入的内容（递尺子，不下命令）
 *
 * 给信息，**承认"不判也行"** —— 干预类提示不惹人烦的要领是让 agent 保留
 * 完全的自主权。只指出"这个失败模式值得看一眼"，并给出一条无论如何
 * 都有用的建议（别再原样重试）。
 */

/** 监听器事件名（宿主 `ToolRuntime` 的 post-execute waterfall）。 */
const POST_EXECUTE_EVENT = 'tools/post-execute';

/** 同一工具在窗口内失败多少次才值得介入。 */
const FAILURE_THRESHOLD = 2;

/**
 * 同一签名在窗口内累计到这个数，语气升级为"该怀疑假设了"。
 *
 * 为什么是 3：第 2 次只说明"重复"；到第 3 次仍无进展，才够得上
 * "你判断的因果结构可能错了"这一层。升级不是提高介入频率
 * （频率仍由 signature 去重与冷却期控制），只是**换说法**。
 */
const ESCALATE_THRESHOLD = 3;

/**
 * 滑动窗口宽度（毫秒）。
 *
 * ## 为什么是 10 分钟而不是 2 分钟（2026-10-30 真实转录复算）
 *
 * 把 1186 条真实失败按"相邻同签名失败对"统计间隔：
 *
 * | 间隔 | 对数 | 占比 |
 * | --- | --- | --- |
 * | ≤2 分钟 | 108 | 39.7% |
 * | 2–10 分钟 | 61 | 22.4% |
 * | >10 分钟 | 103 | 37.9% |
 *
 * 2 分钟窗口只能覆盖不到四成。而真实的"反复调整"往往跨了更久——
 * 中间夹着读文件、查文档、改别的文件。10 分钟能把覆盖提到 62%，
 * 代价是窗口里可能混进两次无关失败（签名相同即视为同类，误报率未上升）。
 */
const WINDOW_MS = 10 * 60_000;

/** 同一 agent 两次介入的最小间隔。 */
const COOLDOWN_MS = 10 * 60_000;

/**
 * 注入的提示正文。
 *
 * ## 为什么按失败类别分支（2026-10-30 真实转录复算）
 *
 * 旧版只有一段固定文案，讲的是"回路/对偶/单向"。但真实触发的 41 次里
 * 有 22% 是机械错误、37% 是设施故障 —— 对它们讲因果结构既不对题也不可执行。
 *
 * 分类闸门（`failure-kind.ts`）已经把 MECH/INFRA 挡在外面，所以这里只需
 * 为 SEM 准备文案；但**SEM 内部仍分两种处境**，要的话不一样：
 *
 * - `repeated`：同一失败反复出现 → 值得怀疑类型假设，请判因果结构。
 * - `escalating`：同类失败已经连续多轮 → 更该考虑"这个因果假设本身错了"。
 *
 * 两者都保留"不判也行"，并给一条无论如何都有用的建议（别原样重试）。
 */

/** 提示的两种语气。 */
export type HintTone = 'repeated' | 'escalating';

/**
 * 造提示正文。
 *
 * @param tone 语气：首次达阈值 / 反复到值得怀疑假设。
 * @returns 提示正文（常量拼接，无 I/O）。
 */
export function hintTextFor(tone: HintTone = 'repeated'): string {
  if (tone === 'escalating') {
    return [
      '同一个失败模式已经反复出现多轮了 —— 值得怀疑的不是这一步，而是**你判断的因果结构**。',
      '`clis_run` 可以先判一下：回路会越修越弹，对偶会一边修一边被拉回去，单向要追溯到最早的因。',
      '如果上次判过并动手了，把真实结果回填到 `last_outcome` —— 它会在反复失败时告诉你"这个因果假设本身可能是错的"。',
      '不判也行；但这次别再原样重试了。',
    ].join('\n');
  }
  return [
    '连续的同类工具失败值得先看一眼：这个失败模式已经重复出现。',
    '`clis_run` 可以先判一下它的因果结构 —— 回路会越修越弹，对偶会一边修一边被拉回去，',
    '单向要追溯到最早的因而不是在结果处使力。',
    '不判也行；但这次别再原样重试了 —— 同样的输入只会得到同样的失败。',
  ].join('\n');
}

/** 一次失败的记录（滑动窗口的元素）。 */
interface FailureRecord {
  readonly at: number;
  readonly signature: string;
}

/** 全部判定所需的状态。集中成一个对象，便于测试注入与整体重置。 */
export interface InterveneState {
  /** `agentId\0工具名` → 该 agent 在该工具上的窗口内失败记录。 */
  readonly windows: Map<string, FailureRecord[]>;
  /** agentId → 上次介入时间。 */
  readonly lastIntervened: Map<string, number>;
  /** agentId → 已提醒过的 signature 集合。 */
  readonly hinted: Map<string, Set<string>>;
}

export function createInterveneState(): InterveneState {
  return {
    windows: new Map(),
    lastIntervened: new Map(),
    hinted: new Map(),
  };
}

/** 注入消息的最小形状（宿主 UserMessage 的子集）。 */
interface InjectedMessage {
  readonly id: string;
  readonly role: 'user';
  readonly source: { readonly kind: string };
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
}

/**
 * 造一条注入消息。
 *
 * 优先用**宿主那一份** `createUserMessage`：宿主消息要求 `id` 存在且唯一
 * （inbox 按 id 去重、durable 校验要求合规对象），宿主自己的实现用
 * randomUUID 生成 id。
 *
 * 宿主模块取不到时（纯 Node 环境：单测、冒烟）退回本地形状 —— 但**必须
 * 造出唯一 id**，否则同一轮注入两条会因 id 相同被宿主拒绝。
 * 计数器 + 时间戳保证同一毫秒内的两条也不撞。
 *
 * @param text 提示正文。
 * @returns 注入消息。
 */
export function createInjectedMessage(text: string): InjectedMessage {
  try {
    return getCreateUserMessage()({
      source: { kind: 'plugin:clis' },
      content: [{ type: 'text', text }],
    }) as InjectedMessage;
  } catch {
    // 宿主不可用：退回本地形状（仍然带唯一 id）。
  }
  injectedCounter += 1;
  return {
    id: `clis-hint-${Date.now().toString(36)}-${injectedCounter.toString(36)}`,
    role: 'user',
    source: { kind: 'plugin:clis' },
    content: [{ type: 'text', text }],
  };
}

/** 本地兜底用的单调计数器（同毫秒内的两条也要不同 id）。 */
let injectedCounter = 0;

/**
 * 从工具结果与调用信息提取**失败签名**。
 *
 * 签名的用途是去重：同一工具、同一类失败算同一个。刻意**不含**时间与
 * 随机量，保证"重复的同一种失败"落在同一个签名上；也刻意**不含完整参数**，
 * 因为参数里常有路径/ID 这类每次都不同的东西，会把"同一类失败"拆成
 * 无数个签名，让去重失效。
 *
 * ## 为什么要降噪（2026-10-30 真实转录复算）
 *
 * 旧版把整段消息前 120 字都算进签名。对 `pwsh` 这类工具，正文里混着
 * stdout、stderr、进度条、时间戳 —— **同一个根因常常算出不同签名**，
 * 于是"重复"永远凑不够 2 次。实测 1186 条真实失败里，相邻同签名失败对
 * 只有 272 对，其中落在 2 分钟窗口内的仅 108 对。
 *
 * 降噪规则：先取**第一行有内容的错误行**（错误信息几乎总在最前面或
 * `[stderr]` 之后），再归一化数字与路径。
 *
 * @param tool 工具名。
 * @param message 失败消息。
 * @returns 签名字符串。
 */
export function failureSignature(tool: string, message: string): string {
  const normalized = firstErrorLine(message)
    .replace(/\d+/g, '#') // 数字归一：路径中的 id、行号、字节量都视为同一形态
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return `${tool}:${normalized}`;
}

/**
 * 取消息里**最能代表这次失败的那一行**。
 *
 * 为什么不是直接取前 120 字：`pwsh` 的结果里，真正的原因常在
 * `[stderr]` 之后、或者夹在 stdout 中间；而前 120 字往往是进度条与
 * 正常输出，每次都不一样 —— 那会把同一类失败拆成无数签名。
 *
 * 策略：优先第一个含错误标记的行；没有标记就取第一个非空行。
 *
 * @param message 失败消息。
 * @returns 代表行（可能为空串）。
 */
function firstErrorLine(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  const ERROR_MARK =
    /error|failed|failure|not found|cannot|unable|denied|invalid|exception|traceback|✗|✖/i;
  const hit = lines.find((line) => ERROR_MARK.test(line));
  return hit ?? lines[0]!;
}

/**
 * 判定是否应当介入 —— **纯函数**，所有策略都在这里，便于穷举测试。
 *
 * @param state 全局介入状态（会被滑动窗口更新）。
 * @param agentId agent 标识。
 * @param tool 失败的工具名。
 * @param message 失败消息。
 * @param now 当前时间（测试注入）。
 * @returns 应注入的提示正文；不介入时 undefined。
 */
export function shouldIntervene(
  state: InterveneState,
  agentId: string,
  tool: string,
  message: string,
  now: number,
): string | undefined {
  // —— 闸门 0：这次失败值不值得用因果结构介入 ——
  //
  // 放在最前面（早于任何记账）：不值得介入的失败连窗口都不该占。
  // 否则一个 agent 连续撞 5 次 `old_string was not found`，会把窗口塞满，
  // 挤掉后面真正该管的语义型失败。
  const kind = classifyFailureKind(tool, message);
  if (!worthCausalIntervention(kind)) return undefined;

  const signature = failureSignature(tool, message);

  // —— 闸门 2：滑动窗口计数（按 agent+工具 分桶）——
  // 为什么按 agent 隔离：多 agent 并发时，A 的失败不应计入 B 的窗口 ——
  // B 第一次失败就被 A 的历史顶到阈值，等于 B 替 A 的故障买单（真机诊断发现）。
  // 失败是否"重复"是每个 agent 自己的体验。
  const bucket = `${agentId}\u0000${tool}`;
  let window = state.windows.get(bucket);
  if (window === undefined) {
    window = [];
    state.windows.set(bucket, window);
  }
  window.push({ at: now, signature });
  while (window.length > 0 && now - window[0]!.at > WINDOW_MS) {
    window.shift();
  }
  const sameSignature = window.filter((r) => r.signature === signature).length;
  if (sameSignature < FAILURE_THRESHOLD) return undefined;

  // —— 闸门 3a：同一 signature 只提醒一次 ——
  let hinted = state.hinted.get(agentId);
  if (hinted === undefined) {
    hinted = new Set();
    state.hinted.set(agentId, hinted);
  }
  if (hinted.has(signature)) return undefined;

  // —— 闸门 3b：冷却期 ——
  const last = state.lastIntervened.get(agentId);
  if (last !== undefined && now - last < COOLDOWN_MS) return undefined;

  // 两个抑制闸门都过了：记账并介入。hinted 永不清除 —— agent 真去调了
  // clis_run 之后，是它自己的选择；同一个失败没必要再唠叨第二遍。
  hinted.add(signature);
  state.lastIntervened.set(agentId, now);
  // 语气：窗口内该签名已累计到 3 次以上，说明不是偶发 —— 该怀疑假设了。
  return hintTextFor(sameSignature >= ESCALATE_THRESHOLD ? 'escalating' : 'repeated');
}

/**
 * agent 真正调用了 `clis_run` —— 提示被听进去了。
 *
 * 清掉该 agent 的冷却期与全部 hinted 记录：不是"又要提醒"，而是
 * "这一轮它已经在用 CLIS 了，接下来它要什么工具都拿得到"。
 * 下一轮新失败仍会按窗口计数正常判定。
 *
 * @param state 全局介入状态。
 * @param agentId agent 标识。
 */
export function markToolUsed(state: InterveneState, agentId: string): void {
  state.lastIntervened.delete(agentId);
  state.hinted.delete(agentId);
}

/**
 * 提取结果里的失败消息。
 *
 * ToolExecutionFailure 的 `error` 是 ToolFailure；message 可能在
 * `error.message` 或 content 文本块里。取不到就返回空串 —— 空串的签名
 * 仍能聚合同一工具的失败，只是类别更粗。
 *
 * @param result 工具结果（post-execute 原样给出）。
 * @returns 失败消息文本；成功结果返回空串。
 */
export function failureMessageOf(result: unknown): string {
  const r = result as {
    isError?: unknown;
    error?: { message?: unknown; info?: { message?: unknown } };
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (r?.isError !== true) return '';
  if (typeof r.error?.message === 'string' && r.error.message.length > 0) {
    return r.error.message;
  }
  if (typeof r.error?.info?.message === 'string') return r.error.info.message;
  const text = (r.content ?? []).find((b) => b?.type === 'text' && typeof b.text === 'string');
  return typeof text?.text === 'string' ? text.text : '';
}

/**
 * 判定一个**成功结果**是否其实是一次失败 —— 非零退出码。
 *
 * ## 为什么必须单独看（2026-10-30 真机事故）
 *
 * 宿主的 shell 类工具（pwsh / bash / bash-persistent）**把非零退出码
 * 报成成功结果**：`isError === false`，退出码放在 `value.exitCode`，
 * 文本里带 `[exit code: 7]` 标记。宿主源码注释写得很清楚：
 * "Non-zero exits are reported, not errored — the model decides how to
 * react; only infrastructure failures surface as isError results."
 *
 * 只盯 `isError` 的话，**最常见的真实失败（命令跑失败）根本到不了闸门**：
 * 实测两次 `exit 7` 后 `hinted` 计数纹丝不动。而"命令反复跑失败"恰恰是
 * 干预机制最该介入的场景。
 *
 * 判据严格限定在**退出码 ≠ 0**，不碰 stderr、不碰输出文本 ——
 * 与既有洞察「原生命令退出码判据」一致：stderr 是噪音，管道会吞退出码。
 *
 * @param result 工具结果（post-execute 原样给出）。
 * @returns 非零退出码时的失败描述；否则 undefined。
 */
export function exitCodeFailureOf(result: unknown): string | undefined {
  const r = result as {
    isError?: unknown;
    value?: { exitCode?: unknown; signal?: unknown; timedOut?: unknown };
  };
  // 只看成功结果：失败结果已由 isError 路径覆盖，不重复计。
  if (r?.isError !== false) return undefined;
  const exitCode = r.value?.exitCode;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode) || exitCode === 0) {
    return undefined;
  }
  // 被信号杀掉不算"命令跑失败"：那是另一种故障，且 signal 场景宿主会另行标记。
  if (r.value?.signal !== undefined && r.value?.signal !== null) return undefined;
  return `exit code ${exitCode}`;
}

/**
 * 注册反馈介入监听器。
 *
 * ⚠️ **订阅必须走 `ctx.on`，不是 `ctx.tools.on`**（2026-10-30 真机事故）：
 * 宿主的 `tools/post-execute` 是 **Context 事件**。`ToolRuntime` 服务只暴露
 * presentAs/register/restrict/guard/get/schemas/executionMode/execute，
 * **没有 `on` 方法**——宿主自己的实现全是 `ctx.on('tools/post-execute', …)`。
 * 旧代码把事件挂在服务对象上并 `if (ctx.tools.on === undefined) return`，
 * 于是监听器从未注册、指标文件从未生成（hinted 恒 0），而单元测试的假 ctx
 * 恰好造了 `tools.on`，692 例全绿掩盖了它。
 *
 * 兼容保留 `tools.on` 作为兜底（旧测试/旧宿主），但**首选 ctx.on**。
 *
 * waterfall 失败绝不外抛 —— 介入是增强，不是链路的一环。监听器随
 * `ctx.effect` 的返回值在卸载时注销。
 *
 * @param ctx 插件上下文（需具备 tools 服务）。
 * @param state 可注入状态；缺省自建。
 * @param dshHome 指标落盘目录；缺省按环境推导（测试注入用）。
 * @returns 注销函数；未注册时 undefined。
 */
export function registerIntervener(
  ctx: Context,
  state: InterveneState = createInterveneState(),
  dshHome: string = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'),
): (() => void) | undefined {
  const host = ctx as unknown as {
    tools?: {
      on?: (
        event: string,
        listener: (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>,
        options?: unknown,
      ) => () => void;
    };
    on?: (
      event: string,
      listener: (...args: unknown[]) => unknown,
      options?: unknown,
    ) => () => void;
  };
  // 宿主事件在 Context 上；`ctx.tools.on` 只可能是旧宿主或测试替身。
  // 两个来源的形状不同（Context 的 on 是 (...args) => unknown，旧替身是
  // waterfall 专用签名），调用点只关心"注册一个 waterfall 监听器"，
  // 故在这里归一成同一签名再使用。
  type Subscribe = (
    event: string,
    listener: (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    options?: unknown,
  ) => () => void;
  const subscribe: Subscribe | undefined = typeof host.on === 'function'
    ? (event, listener) => (host.on as Subscribe)(event, listener)
    : host.tools?.on === undefined
      ? undefined
      : (event, listener) => (host.tools!.on as Subscribe)(event, listener);
  if (subscribe === undefined) return undefined;

  const listener = async (
    exec: unknown,
    result: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = (await next()) as {
      kind?: string;
      additionalContexts?: unknown[];
      [key: string]: unknown;
    };

    // —— agent 调用 CLIS 工具：先于成功跳过处理 ——
    // 为什么必须在这里：clis_run/classify 绝大多数调用是**成功**的，若把
    // 这段放在 isError 判断之后，成功路径会提前 return，adopted 永远记不上
    // （真机诊断发现：decision 直接是 {kind:'accept'}，账没落）。
    const e0 = exec as { name?: unknown; agent?: { id?: unknown } } | null;
    const tool0 = typeof e0?.name === 'string' ? e0.name : '';
    if (tool0 === 'clis_run' || tool0 === 'clis_classify') {
      const agentId0 = typeof e0?.agent?.id === 'string' ? e0.agent.id : 'default';
      // agent 自己用了 CLIS：提示已被采纳，清抑制状态；记 adopted。
      //
      // ⚠️ 但"调了 CLIS"不等于"提示被采纳"（2026-10-30 真实数据修正）：
      // 实测 5 次 adopted 里 1 次此前零提示 —— 那只是 agent 自己想起来用。
      // 汇总时按事件顺序判定是否真有前提提示（见 summarizeMetrics），
      // 这里如实记下距最近一次提示的间隔，供汇总侧做条件判断。
      const lastHintAt = state.lastIntervened.get(agentId0);
      markToolUsed(state, agentId0);
      void recordMetric(dshHome, {
        kind: 'adopted',
        agent: agentId0,
        via: tool0,
        ...(lastHintAt === undefined ? {} : { after_hint_ms: Date.now() - lastHintAt }),
      });
      return decision;
    }

    // 成功结果零成本跳过（闸门 1）。不读字段、不算签名。
    //
    // ⚠️ 但"成功"不等于"没问题"：宿主 shell 类工具把**非零退出码报成成功**
    // （isError=false，退出码在 value.exitCode）。只盯 isError 的话，
    // 最常见的真实失败（命令跑失败）永远到不了闸门 —— 实测两次 exit 7
    // 后 hinted 纹丝不动。故这里先问一次"退出码是不是非零"。
    const r = result as { isError?: unknown } | null | undefined;
    const exitFailure = r?.isError === true ? undefined : exitCodeFailureOf(result);
    if (r?.isError !== true && exitFailure === undefined) return decision;

    try {
      const e = exec as { name?: unknown; agent?: { id?: unknown } } | null;
      const tool = typeof e?.name === 'string' ? e.name : 'unknown';
      const agentId = typeof e?.agent?.id === 'string' ? e.agent.id : 'default';

      // 失败描述：isError 走错误消息；非零退出码走退出码描述。
      const message = exitFailure ?? failureMessageOf(result);
      const hint = shouldIntervene(state, agentId, tool, message, Date.now());
      if (hint === undefined) return decision;

      // 注入了提示：记 hinted —— 采用率的分母。签名一并记下，
      // 便于把"哪类失败最常触发介入"与"哪类被采纳"关联起来。
      const signature = failureSignature(tool, message);
      void recordMetric(dshHome, { kind: 'hinted', agent: agentId, tool, signature });

      // 注入的消息必须用宿主（或等价本地实现）造出唯一 id。
      //
      // ⚠️ 不能手写 `{role,source,content}`（2026-10-30 真机发现）：宿主消息
      // 要求 `id` 存在且唯一 —— inbox 按 id 去重（`message "<id>" is already
      // pending` 会抛），durable 校验也要求合规对象。手写形状缺 id 时，
      // 单条注入侥幸能过，**同一轮注入两条**就因 id 相同被宿主拒绝。
      const context = createInjectedMessage(hint);
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), context],
      };
    } catch {
      return decision; // 任何判定失败都退回"沉默"，绝不打断工具链路
    }
  };

  // Context 事件订阅（waterfall；回调随 fiber 卸载）。
  return subscribe(POST_EXECUTE_EVENT, listener);
}