import type { Context } from '@deepseek-ai/cordis';

/**
 * 把 CLIS 的存在感注入系统提示 —— 让 agent **每一轮都能想起来**用它。
 *
 * 为什么需要这层（而不只是把工具注册进工具表）：
 * 工具表里"有"不等于"会想起来用"。agent 面对一个真实任务时，脑子里的
 * 第一反应是"这个现象该怎么处理"，而不是"要不要判断一下因果类型"。
 * 工具 description 只在它主动去找工具时才起作用。
 *
 * 这段文字因此写成**症状触发**：列出用户实际会说的话
 * （"改了没效果""越调越糟""这两个到底谁影响谁"），
 * 让它在遇到这些信号时自然联想到 CLIS，而不是记住一个工具名。
 *
 * 篇幅刻意压到很短：系统提示每轮都要付 token，一段 200 字的常驻文字
 * 必须证明自己的价值。这里只写"什么时候用"，不重复工具定义里的
 * 参数说明与返回结构（那些在工具 description 里，用到时才加载）。
 */

/** 系统提示段名称（全局唯一，重复注册会抛错）。 */
const SECTION_NAME = 'clis-causal-reasoning';

/**
 * 段落位置：紧跟 TOOL_GOAL(2400)、在 TOOL_WORKFLOW(2600) 之前。
 *
 * 选这个位置的理由：它属于"推理辅助"而非某个具体工具的操作说明，
 * 放在目标之后、工作流之前，正好在 agent 决定"怎么推进"的时刻被读到。
 */
const SECTION_ORDER = 2450;

/**
 * 系统提示正文。
 *
 * 只回答两个问题：**什么时候想它**、**用它来干什么**。
 */
const SECTION_TEXT = [
  '# 因果结构判断',
  '',
  '遇到这些信号时，先判断因果结构再动手，不要直接给方案：',
  '- 改了参数/策略但没效果，或反复调整反而更糟',
  '- 指标来回震荡，压下去又弹回来',
  '- 两个因素互相影响，分不清谁是因谁是果',
  '- 想知道"这个措施为什么无效"，而不是"下一步做什么"',
  '',
  '`clis_run` 会判定是单向因果、反馈回路、互为定义还是多种结构并存，',
  '并给出与之匹配的处理路径——这几种结构需要完全相反的做法，判错方向会让努力白费。',
  '只想知道结构不想看方案时用 `clis_classify`；只想看几种做法及其代价时用 `clis_plan`。',
  '',
  '动手之后再回来调用一次并回填 `last_outcome`（真实结果），',
  '反复无效时它会告诉你"这个因果假设本身可能是错的"，而不只是继续给方案。',
].join('\n');

/**
 * 注册系统提示段。
 *
 * 只有在 `systemPrompt` 服务可用时才注册：纯 Node 环境（单测、冒烟）
 * 没有这个服务，缺它不该让整个插件装载失败。
 *
 * @param ctx 已具备 systemPrompt 服务的上下文。
 * @returns 注销函数；未注册时返回 undefined。
 */
export function registerPromptSection(ctx: Context): (() => void) | undefined {
  const host = ctx as unknown as {
    systemPrompt?: {
      section(section: { name: string; order: number; text: string }): () => void;
    };
  };

  if (host.systemPrompt === undefined) return undefined;

  return host.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: SECTION_TEXT,
  });
}

export { SECTION_NAME, SECTION_TEXT };
