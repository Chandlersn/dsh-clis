/**
 * 回归：反馈介入的四道闸门。
 *
 * 定位（2026-10-26 用户确定）：CLIS 不改变 agent 最初的想法，而是
 * **碰到问题和反馈时介入**，帮它理清归因分类。介入的价值全在时机上：
 * 早了是干扰（agent 正常推进时插话），晚了没用（失败模式已固化）。
 *
 * 本套件穷举四道闸门的**每一侧**——尤其是不介入的那一侧：
 * 闸门 1  只盯失败（成功零成本跳过）
 * 闸门 2  同一工具窗口内失败 ≥2 次才值得看（1 次失败是正常波动）
 * 闸门 3  signature 只提醒一次 + 冷却期（防唠叨）
 * 闸门 4  注入内容递尺子不下命令（承认"不判也行"）
 */
import { describe, expect, it } from 'vitest';

import {
  createInterveneState,
  failureMessageOf,
  failureSignature,
  markToolUsed,
  shouldIntervene,
} from '../packages/clis-plugin/src/intervene';

/** 固定时钟起点。 */
const T0 = 1_700_000_000_000;
const WINDOW = 2 * 60_000;
const COOLDOWN = 10 * 60_000;

/** 快捷失败。 */
function fail(
  state = createInterveneState(),
  agentId = 'agent-1',
  tool = 'fs_write',
  message = 'ENOENT: no such file',
  now = T0,
) {
  return shouldIntervene(state, agentId, tool, message, now);
}

describe('闸门 2：一次失败不介入，同类失败达阈值才介入', () => {
  it('第一次失败 → 沉默', () => {
    const state = createInterveneState();
    expect(fail(state)).toBeUndefined();
  });

  it('同一工具第二次同类失败 → 给出提示', () => {
    const state = createInterveneState();
    expect(fail(state)).toBeUndefined();
    expect(fail(state)).toBe(HINT());
  });

  it('两个不同工具各失败一次 → 都沉默（窗口按 agent+工具 分桶）', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write')).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_read')).toBeUndefined();
  });

  it('窗口过期后即使重复失败也重新计数（不跨窗口累计）', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0)).toBeUndefined();
    // 超出窗口
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + WINDOW + 1)).toBeUndefined();
    // 窗口内第二次
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + WINDOW + 2)).toBe(HINT());
  });

  it('签名不同（不同的失败消息）不累计', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file')).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'EACCES: permission denied')).toBeUndefined();
  });

  it('签名把数字归一：同一类失败只是数字不同也累计', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', 'line 12: bad token')).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'line 47: bad token')).toBe(HINT());
  });
});

describe('闸门 3：抑制——同一件事不唠叨两遍', () => {
  it('同一 signature 第二轮 → 不再提醒（直到 agent 用了 CLIS）', () => {
    const state = createInterveneState();
    expect(fail(state)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 1)).toBe(HINT());
    // 第三次同类失败：signature 已去重，沉默（冷却期过了也不提醒）
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + COOLDOWN + 1)).toBeUndefined();
  });

  it('冷却期内的新 signature → 沉默（不让提示排队轰炸）', () => {
    const state = createInterveneState();
    // 第一组失败触发介入
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 1)).toBe(HINT());
    // 冷却期内（< 10min）另一工具的新 signature：沉默
    expect(fail(state, 'agent-1', 'net_fetch', 'timeout', T0 + COOLDOWN - 1)).toBeUndefined();
    expect(fail(state, 'agent-1', 'net_fetch', 'timeout', T0 + COOLDOWN - 1)).toBeUndefined();
  });

  it('冷却期后（≥ 10min）新 signature → 可以介入', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 1)).toBe(HINT());
    // 恰好到冷却期
    expect(fail(state, 'agent-1', 'net_fetch', 'timeout', T0 + COOLDOWN)).toBeUndefined();
    expect(fail(state, 'agent-1', 'net_fetch', 'timeout', T0 + COOLDOWN + 1)).toBe(HINT());
  });

  it('markToolUsed 清抑制：agent 用了 clis_run 后，同类失败可再次提醒', () => {
    const state = createInterveneState();
    expect(fail(state)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 1)).toBe(HINT());
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 2)).toBeUndefined();

    // agent 真去调了 clis_run
    markToolUsed(state, 'agent-1');

    // 同类失败再来一次：窗口内计数仍 ≥2（前两次还在窗口里），signature 与
    // 冷却都已清 → 立即再次提醒。markToolUsed 的语义正是"下一轮同模式失败
    // 重新获得提醒资格"。
    expect(fail(state, 'agent-1', 'fs_write', 'ENOENT: no such file', T0 + 3)).toBe(HINT());
  });

  it('agent 之间互不影响（A 的冷却不压制 B）', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-A', 'fs_write', 'ENOENT: no such file', T0)).toBeUndefined();
    expect(fail(state, 'agent-A', 'fs_write', 'ENOENT: no such file', T0 + 1)).toBe(HINT());
    // agent-B 全新状态：第一次沉默，第二次介入
    expect(fail(state, 'agent-B', 'fs_write', 'ENOENT: no such file', T0 + 2)).toBeUndefined();
    expect(fail(state, 'agent-B', 'fs_write', 'ENOENT: no such file', T0 + 3)).toBe(HINT());
  });
});

describe('闸门 4：注入内容递尺子不下命令', () => {
  it('提示承认"不判也行"，并给出一条无条件的建议', () => {
    const text = HINT();
    expect(text).toContain('不判也行');
    expect(text).toContain('别再原样重试');
  });

  it('提示点名三种结构性后果（回路/对偶/单向），不说"会更快捷"', () => {
    const text = HINT();
    expect(text).toContain('回路');
    expect(text).toContain('对偶');
    expect(text).toContain('单向');
    // 效果宣称的禁词：没有对照实验，不写"更快/更好/更准"
    expect(text).not.toMatch(/更快捷|更有效|更准确/);
  });
});

describe('failureMessageOf：从工具结果提取失败消息', () => {
  it('成功结果 → 空串（闸门 1 的前提）', () => {
    expect(failureMessageOf({ isError: false, error: undefined })).toBe('');
    expect(failureMessageOf({ isError: undefined })).toBe('');
    expect(failureMessageOf(null)).toBe('');
    expect(failureMessageOf(undefined)).toBe('');
  });

  it('error.message 存在时优先', () => {
    expect(
      failureMessageOf({
        isError: true,
        error: { message: 'boom', info: { message: 'inner' } },
      }),
    ).toBe('boom');
  });

  it('error.message 缺失时退回 error.info.message，再退回 content 文本', () => {
    expect(failureMessageOf({ isError: true, error: { info: { message: 'inner' } } })).toBe('inner');
    expect(
      failureMessageOf({ isError: true, content: [{ type: 'text', text: 'from content' }] }),
    ).toBe('from content');
    expect(failureMessageOf({ isError: true })).toBe('');
  });
});

describe('failureSignature：去重键的稳定性', () => {
  it('数字归一：路径里的 id/行号不影响归类', () => {
    expect(failureSignature('t', 'file /a/b/123.txt missing')).toBe(
      failureSignature('t', 'file /a/b/999.txt missing'),
    );
  });

  it('空白归一：换行与多空格不影响归类', () => {
    expect(failureSignature('t', 'a\n\n  b')).toBe(failureSignature('t', 'a b'));
  });

  it('长度截断：超长消息在 120 字处截断（尾部差异不影响）', () => {
    const long = 'x'.repeat(300);
    expect(failureSignature('t', long)).toBe(failureSignature('t', 'x'.repeat(200)));
  });

  it('不同工具同名失败 → 不同签名（窗口分桶之外的二道保险）', () => {
    expect(failureSignature('a', 'same message')).not.toBe(failureSignature('b', 'same message'));
  });
});

/** 引用常量，避免测试里复制文案（文案改了这里会先红）。 */
function HINT(): string {
  // 与 intervene.ts 的 HINT_TEXT 同源：直接调一次 shouldIntervene 拿真值。
  const state = createInterveneState();
  shouldIntervene(state, 'seed', 't', 'm', T0);
  return shouldIntervene(state, 'seed', 't', 'm', T0 + 1)!;
}