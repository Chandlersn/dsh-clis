/**
 * 回归：CLIS 的**可发现性** —— 工具 description 与系统提示段。
 *
 * 为什么值得单测（而不是只靠肉眼读文案）：
 * 工具表里"有"不等于"会想起来用"。agent 面对真实任务时的第一反应是
 * "这个现象怎么处理"，不是"要不要判因果类型"。所以：
 * - 工具 description 必须写**症状触发**（用户会说的话），不能只写"我是什么"；
 * - 系统提示段必须在，且足够短（每轮都付 token）。
 *
 * 这两点都会在后续改文案时被无声破坏，故据此钉住。
 */
import { describe, expect, it } from 'vitest';

import { SECTION_NAME, SECTION_TEXT } from '../packages/clis-plugin/src/prompt';

describe('系统提示段', () => {
  it('段名固定（全局唯一，改名会与注册表冲突）', () => {
    expect(SECTION_NAME).toBe('clis-causal-reasoning');
  });

  it('正文非空且不超过体积预算', () => {
    expect(SECTION_TEXT.trim().length).toBeGreaterThan(100);
    // 每轮都要付 token；超过 1200 字说明写成了文档，该精简
    expect(SECTION_TEXT.length).toBeLessThan(1200);
  });

  it('包含症状触发：用户会说的话，而不是工具名', () => {
    // 这些是 agent 真正能观察到的信号
    for (const symptom of ['没效果', '更糟', '震荡', '谁是因']) {
      expect(SECTION_TEXT).toContain(symptom);
    }
  });

  it('点名三个工具，便于 agent 直接调用', () => {
    for (const tool of ['clis_run', 'clis_classify', 'clis_plan']) {
      expect(SECTION_TEXT).toContain(tool);
    }
  });

  it('说明三种结构需要相反做法（这是"为什么要判断"的核心理由）', () => {
    expect(SECTION_TEXT).toContain('相反');
  });

  it('提到回填 last_outcome —— 否则误判检测永远不触发', () => {
    expect(SECTION_TEXT).toContain('last_outcome');
  });

  it('不重复工具定义里的参数细节（避免两处维护）', () => {
    // 参数名不该出现在系统提示里，它们属于工具 description
    for (const param of ['q1', 'q2', 'q3', 'q4', 'forbidden_actions', 'allow_writes']) {
      expect(SECTION_TEXT).not.toContain(param);
    }
  });
});
