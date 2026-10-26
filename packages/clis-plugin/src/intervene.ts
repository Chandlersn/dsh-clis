import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';

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
 * 1. **信号**：只盯 `isError === true` 的结果。成功 = agent 在正常推进，
 *    此时插话是纯干扰。第一版刻意不盯"重复调用"——幂等工具（读文件、
 *    查状态）连续跑两次是正常操作，误报成本高于漏报。
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

/** 滑动窗口宽度（毫秒）。 */
const WINDOW_MS = 2 * 60_000;

/** 同一 agent 两次介入的最小间隔。 */
const COOLDOWN_MS = 10 * 60_000;

/** 注入的提示正文。常量：无计算、无 I/O，长度即 token 成本的上限。 */
const HINT_TEXT = [
  '连续的同类工具失败值得先看一眼：这个失败模式已经重复出现。',
  '`clis_run` 可以先判一下它的因果结构 —— 回路会越修越弹，对偶会一边修一边被拉回去，',
  '单向要追溯到最早的因而不是在结果处使力。',
  '不判也行；但这次别再原样重试了 —— 同样的输入只会得到同样的失败。',
].join('\n');

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

/**
 * 从工具结果与调用信息提取**失败签名**。
 *
 * 签名的用途是去重：同一工具、同一类失败算同一个。刻意**不含**时间与
 * 随机量，保证"重复的同一种失败"落在同一个签名上；也刻意**不含完整参数**，
 * 因为参数里常有路径/ID 这类每次都不同的东西，会把"同一类失败"拆成
 * 无数个签名，让去重失效。
 *
 * @param tool 工具名。
 * @param message 失败消息（取前 120 字，路径参数的目录前缀差异不影响类别判断）。
 * @returns 签名字符串。
 */
export function failureSignature(tool: string, message: string): string {
  const normalized = message
    .replace(/\d+/g, '#') // 数字归一：路径中的 id、行号、字节量都视为同一形态
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return `${tool}:${normalized}`;
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
  return HINT_TEXT;
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
 * 注册反馈介入监听器。
 *
 * 只在 `tools` 服务可用时注册；waterfall 失败绝不外抛 —— 介入是增强，
 * 不是链路的一环。监听器随 `ctx.effect` 的返回值在卸载时注销。
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
  if (host?.tools?.on === undefined) return undefined;

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
      // agent 自己用了 CLIS：提示已被采纳，清抑制状态；记 adopted —— 采用率的分子。
      markToolUsed(state, agentId0);
      void recordMetric(dshHome, { kind: 'adopted', agent: agentId0, via: tool0 });
      return decision;
    }

    // 成功结果零成本跳过（闸门 1）。不读字段、不算签名。
    const r = result as { isError?: unknown } | null | undefined;
    if (r?.isError !== true) return decision;

    try {
      const e = exec as { name?: unknown; agent?: { id?: unknown } } | null;
      const tool = typeof e?.name === 'string' ? e.name : 'unknown';
      const agentId = typeof e?.agent?.id === 'string' ? e.agent.id : 'default';

      const message = failureMessageOf(result);
      const hint = shouldIntervene(state, agentId, tool, message, Date.now());
      if (hint === undefined) return decision;

      // 注入了提示：记 hinted —— 采用率的分母。签名一并记下，
      // 便于把"哪类失败最常触发介入"与"哪类被采纳"关联起来。
      const signature = failureSignature(tool, message);
      void recordMetric(dshHome, { kind: 'hinted', agent: agentId, tool, signature });

      // createUserMessage 的形状照 memory-manager 的注入先例：
      // { role:'user', source:{kind}, content:[{type:'text',text}] }。
      // 这里手写最小形状而不是引宿主函数 —— 介入层刻意零宿主依赖，
      // 坏了也不影响工具链路。
      const context = {
        role: 'user',
        source: { kind: 'plugin:clis' },
        content: [{ type: 'text', text: hint }],
      };
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), context],
      };
    } catch {
      return decision; // 任何判定失败都退回"沉默"，绝不打断工具链路
    }
  };

  // tools 服务的事件订阅（与 pre-execute guard 同一层）；回调随 fiber 卸载。
  return host.tools.on(POST_EXECUTE_EVENT, listener);
}