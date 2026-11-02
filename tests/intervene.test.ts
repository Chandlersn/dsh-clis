/**
 * 回归：反馈介入的四道闸门。
 *
 * 定位（2026-10-26 用户确定）：CLIS 不改变 agent 最初的想法，而是
 * **碰到问题和反馈时介入**，帮它理清归因分类。介入的价值全在时机上：
 * 早了是干扰（agent 正常推进时插话），晚了没用（失败模式已固化）。
 *
 * 本套件穷举四道闸门的**每一侧**——尤其是不介入的那一侧：
 * 闸门 0  失败性质（MECH/INFRA 不介入，只有 SEM 值得判因果）
 * 闸门 1  只盯失败（成功零成本跳过）
 * 闸门 2  同一工具窗口内失败 ≥2 次才值得看（1 次失败是正常波动）
 * 闸门 3  signature 只提醒一次 + 冷却期（防唠叨）
 * 闸门 4  注入内容递尺子不下命令（承认"不判也行"）
 */
import { describe, expect, it } from 'vitest';

import {
  createInjectedMessage,
  createInterveneState,
  exitCodeFailureOf,
  failureMessageOf,
  failureSignature,
  hintTextFor,
  markToolUsed,
  shouldIntervene,
  stderrDetailOf,
} from '../packages/clis-plugin/src/intervene';
import { classifyFailureKind } from '../packages/clis-plugin/src/failure-kind';
import type { HintTone } from '../packages/clis-plugin/src/intervene';

/**
 * 取退出码失败的详情（喂给纯函数层的消息正文）。
 *
 * `code` 刻意不参与：详情层只用 stderr 正文，退出码只回答"是不是失败"
 * （见 intervene.ts 的分工）。端到端的取值在 metrics 套件另有真实形状用例。
 */
function stderrOf(_code: number, text: string): string {
  return text;
}

/** 固定时钟起点。 */
const T0 = 1_700_000_000_000;
/** 与 intervene.ts 的 WINDOW_MS 同步（10 分钟；2026-10-30 由 2 分钟放宽）。 */
const WINDOW = 10 * 60_000;
const COOLDOWN = 10 * 60_000;

/**
 * 语义型失败样例 —— 闸门只对这类介入。
 *
 * 为什么默认样例不能再用 `ENOENT: no such file`（2026-10-30）：
 * 加了失败性质分类之后，ENOENT 属 MECH（先确认路径再写就能过），
 * 按设计**不该**触发因果结构提示 —— 它有自己的一组断言（见末尾分类套件）。
 */
const SEM_FAILURE = 'AssertionError: expected 3 to equal 5';

/** 快捷失败。 */
function fail(
  state = createInterveneState(),
  agentId = 'agent-1',
  tool = 'fs_write',
  message = SEM_FAILURE,
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
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0)).toBeUndefined();
    // 超出窗口
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + WINDOW + 1)).toBeUndefined();
    // 窗口内第二次
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + WINDOW + 2)).toBe(HINT());
  });

  it('签名不同（不同的失败消息）不累计', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', 'AssertionError: expected 3 to equal 5')).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', 'TypeError: cannot read property x')).toBeUndefined();
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
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 1)).toBe(HINT());
    // 第三次同类失败：signature 已去重，沉默（冷却期过了也不提醒）
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + COOLDOWN + 1)).toBeUndefined();
  });

  it('冷却期内的新 signature → 沉默（不让提示排队轰炸）', () => {
    const state = createInterveneState();
    // 第一组失败触发介入
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 1)).toBe(HINT());
    // 冷却期内（< 10min）另一工具的新 signature：沉默
    expect(fail(state, 'agent-1', 'net_fetch', 'AssertionError: timeout budget exceeded', T0 + COOLDOWN - 1)).toBeUndefined();
    expect(fail(state, 'agent-1', 'net_fetch', 'AssertionError: timeout budget exceeded', T0 + COOLDOWN - 1)).toBeUndefined();
  });

  it('冷却期后（≥ 10min）新 signature → 可以介入', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 1)).toBe(HINT());
    // 恰好到冷却期
    expect(fail(state, 'agent-1', 'net_fetch', 'AssertionError: timeout budget exceeded', T0 + COOLDOWN)).toBeUndefined();
    expect(fail(state, 'agent-1', 'net_fetch', 'AssertionError: timeout budget exceeded', T0 + COOLDOWN + 1)).toBe(HINT());
  });

  it('markToolUsed 清抑制：agent 用了 clis_run 后，同类失败可再次提醒', () => {
    const state = createInterveneState();
    expect(fail(state)).toBeUndefined();
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 1)).toBe(HINT());
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 2)).toBeUndefined();

    // agent 真去调了 clis_run
    markToolUsed(state, 'agent-1');

    // 同类失败再来一次：窗口内计数仍 ≥2（前两次还在窗口里），signature 与
    // 冷却都已清 → 立即再次提醒。markToolUsed 的语义正是"下一轮同模式失败
    // 重新获得提醒资格"。
    //
    // 注意语气：此时窗口内该签名已累计 3 次，提示升级为 escalating，
    // 故这里只断言"重新获得了提醒"，不断言具体文案（文案见闸门 4 套件）。
    expect(fail(state, 'agent-1', 'fs_write', SEM_FAILURE, T0 + 3)).toBe(HINT('escalating'));
  });

  it('agent 之间互不影响（A 的冷却不压制 B）', () => {
    const state = createInterveneState();
    expect(fail(state, 'agent-A', 'fs_write', SEM_FAILURE, T0)).toBeUndefined();
    expect(fail(state, 'agent-A', 'fs_write', SEM_FAILURE, T0 + 1)).toBe(HINT());
    // agent-B 全新状态：第一次沉默，第二次介入
    expect(fail(state, 'agent-B', 'fs_write', SEM_FAILURE, T0 + 2)).toBeUndefined();
    expect(fail(state, 'agent-B', 'fs_write', SEM_FAILURE, T0 + 3)).toBe(HINT());
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

  // —— 2026-10-30 语气分级 ——
  describe('语气分级：反复到第 3 次才升级为"怀疑假设"', () => {
    it('repeated 语气：只指出"重复出现"', () => {
      const text = hintTextFor('repeated');
      expect(text).toContain('重复出现');
      expect(text).not.toContain('因果假设本身可能是错的');
    });

    it('escalating 语气：点名"该怀疑的是因果结构"，并要 last_outcome', () => {
      const text = hintTextFor('escalating');
      expect(text).toContain('因果结构');
      expect(text).toContain('last_outcome');
      expect(text).toContain('假设本身可能是错的');
    });

    it('两种语气都保留自主权与"别再原样重试"', () => {
      for (const tone of ['repeated', 'escalating'] as const) {
        expect(hintTextFor(tone)).toContain('不判也行');
        expect(hintTextFor(tone)).toContain('别再原样重试');
      }
    });

    it('两种语气都不含效果宣称的禁词', () => {
      for (const tone of ['repeated', 'escalating'] as const) {
        expect(hintTextFor(tone)).not.toMatch(/更快捷|更有效|更准确|保证/);
      }
    });

    it('第 2 次失败给 repeated，第 3 次（清抑制后）给 escalating', () => {
      const state = createInterveneState();
      expect(fail(state, 'a', 't', SEM_FAILURE, T0)).toBeUndefined();
      expect(fail(state, 'a', 't', SEM_FAILURE, T0 + 1)).toBe(hintTextFor('repeated'));
      markToolUsed(state, 'a');
      expect(fail(state, 'a', 't', SEM_FAILURE, T0 + 2)).toBe(hintTextFor('escalating'));
    });

    it('默认语气是 repeated（不传参时不意外升级）', () => {
      expect(hintTextFor()).toBe(hintTextFor('repeated'));
    });
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

describe('exitCodeFailureOf：非零退出码也算失败（2026-10-30 真机补）', () => {
  // 宿主把"命令跑失败"报成**成功**结果：isError=false，退出码在 value 里。
  // 只盯 isError 的话，最常见的真实失败永远到不了闸门。
  it('成功结果但退出码非零 → 判为失败', () => {
    expect(exitCodeFailureOf({ isError: false, value: { exitCode: 7 } })).toBe('exit code 7');
    expect(exitCodeFailureOf({ isError: false, value: { exitCode: 1 } })).toBe('exit code 1');
  });

  it('退出码为 0 → 不算失败', () => {
    expect(exitCodeFailureOf({ isError: false, value: { exitCode: 0 } })).toBeUndefined();
  });

  it('被信号杀掉 → 不算"命令跑失败"（另一种故障，宿主另行标记）', () => {
    expect(
      exitCodeFailureOf({ isError: false, value: { exitCode: 137, signal: 'SIGKILL' } }),
    ).toBeUndefined();
  });

  it('真错误结果（isError=true）不由这条路径重复计', () => {
    expect(exitCodeFailureOf({ isError: true, error: { message: 'boom' } })).toBeUndefined();
  });

  it('没有退出码信息（普通工具）→ 不算失败', () => {
    expect(exitCodeFailureOf({ isError: false, value: { some: 'thing' } })).toBeUndefined();
    expect(exitCodeFailureOf({ isError: false })).toBeUndefined();
    expect(exitCodeFailureOf(null)).toBeUndefined();
  });

  it('退出码非数字 → 不算失败（不猜）', () => {
    expect(exitCodeFailureOf({ isError: false, value: { exitCode: '7' } })).toBeUndefined();
  });

  it('不碰 stderr 与输出文本：只有退出码算数（与退出码判据洞察一致）', () => {
    expect(
      exitCodeFailureOf({
        isError: false,
        value: { exitCode: 0, stdout: { text: 'some warning' }, stderr: { text: 'noise' } },
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2026-11-02 真数据修正：签名塌缩
//
// `exit code N` 的数字被签名归一成 `#`，于是**所有退出码失败共用一个签名**。
// 真机对照：同一 agent 23:07 撞 ConvertFrom-Json 语法错误、23:11 撞
// Join-String 不存在 —— 两个无关错误被记成"同一失败模式"，提示说了假话，
// 0 采纳。修复：失败**详情**取 stderr 正文（宿主 foreground 结果带此字段），
// 而"是不是失败"的判据不变，仍只认退出码。
// ---------------------------------------------------------------------------
describe('stderrDetailOf：退出码失败的详情（签名/分类用，不判失败）', () => {
  it('有 stderr 正文 → 原样返回', () => {
    expect(
      stderrDetailOf({ isError: false, value: { exitCode: 1, stderr: { text: 'boom happened' } } }),
    ).toBe('boom happened');
  });

  it('空串/空白 → undefined（调用方退回 exit code 描述）', () => {
    expect(
      stderrDetailOf({ isError: false, value: { exitCode: 1, stderr: { text: '   ' } } }),
    ).toBeUndefined();
    expect(
      stderrDetailOf({ isError: false, value: { exitCode: 1, stderr: { text: '' } } }),
    ).toBeUndefined();
  });

  it('形状缺失 → undefined，不抛错', () => {
    expect(stderrDetailOf({ isError: false, value: { exitCode: 1 } })).toBeUndefined();
    expect(stderrDetailOf(null)).toBeUndefined();
    expect(stderrDetailOf(undefined)).toBeUndefined();
  });
});

describe('签名塌缩修复：同退出码的不同错误必须有不同签名', () => {
  // 用今晚真机出现的两个错误原话（PowerShell 错误记录）
  const JSON_ERR =
    'ConvertFrom-Json : Invalid object passed in, \':\' or \'}\' expected. (238): { "a": 1 }';
  const CMDLET_ERR =
    'The term \'Join-String\' is not recognized as a name of a cmdlet, function, script file, or executable program.';

  it('两个无关的 exit-code-1 错误 → 不同签名（旧实现两者同为 pwsh:exit code #）', () => {
    const a = failureSignature('pwsh', stderrOf(1, JSON_ERR));
    const b = failureSignature('pwsh', stderrOf(1, CMDLET_ERR));
    expect(a).not.toBe(b);
  });

  it('同一个错误重复两次 → 签名一致（去重仍成立，不是修坏了）', () => {
    const a = failureSignature('pwsh', stderrOf(1, JSON_ERR));
    const b = failureSignature('pwsh', stderrOf(1, JSON_ERR));
    expect(a).toBe(b);
  });

  it('真实分类核对：cmdlet 不存在归 MECH，JSON 解析错误归 SEM（不凭想象写断言）', () => {
    // 'Join-String is not recognized as a name of a cmdlet' 命中 MECH 模式。
    expect(classifyFailureKind('pwsh', CMDLET_ERR)).toBe('MECH');
    // JSON 错误不匹配任何 MECH/INFRA 模式（'Invalid object' ≠ 'Invalid arguments'），
    // 按分类器"拿不准归 SEM，宁可多说"的设计落 SEM —— 断言以实测为准。
    expect(classifyFailureKind('pwsh', JSON_ERR)).toBe('SEM');
  });

  it('无 stderr 时退回 exit code 描述（不猜详情）', () => {
    expect(stderrDetailOf({ isError: false, value: { exitCode: 2 } })).toBeUndefined();
    // 退回后的签名与旧行为一致 —— 增强失败时降级，不改变既有语义
    expect(failureSignature('pwsh', 'exit code 2')).toBe('pwsh:exit code #');
  });

  it('真实分类核对：cmdlet 不存在归 MECH，JSON 解析错误归 SEM（不凭想象写断言）', () => {
    // 'Join-String is not recognized as a name of a cmdlet' 命中 MECH 模式。
    expect(classifyFailureKind('pwsh', CMDLET_ERR)).toBe('MECH');
    // JSON 错误不匹配任何 MECH/INFRA 模式（'Invalid object' ≠ 'Invalid arguments'），
    // 按分类器"拿不准归 SEM，宁可多说"的设计落 SEM —— 断言以实测为准。
    expect(classifyFailureKind('pwsh', JSON_ERR)).toBe('SEM');
  });

  it('闸门端到端：两个无关的 stderr 错误各自 below-threshold，不再互相顶到阈值', () => {
    const state = createInterveneState();
    const r1 = shouldIntervene(state, 'a1', 'pwsh', JSON_ERR, T0);
    const r2 = shouldIntervene(state, 'a1', 'pwsh', CMDLET_ERR, T0 + 1000);
    // 修复前的形态：两者签名同为 pwsh:exit code # —— r2 会把窗口顶到阈值，
    // 于是提示宣称"这个失败模式已经重复出现"（假话）。
    // 修复后：签名不同，各自只出现 1 次，都不该触发。
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });

  it('闸门端到端：真正反复出现的 SEM 错误仍触发（修复没把有用的拦掉）', () => {
    const state = createInterveneState();
    const sem = 'AssertionError: expected 3 to equal 5';
    expect(shouldIntervene(state, 'a1', 'pwsh', stderrOf(1, sem), T0)).toBeUndefined();
    expect(shouldIntervene(state, 'a1', 'pwsh', stderrOf(1, sem), T0 + 1000)).toBeDefined();
  });
});


describe('failureSignature：去重键的稳定性', () => {
  it('数字归一：路径里的 id/行号不影响归类', () => {
    expect(failureSignature('t', 'file /a/b/123.txt missing')).toBe(
      failureSignature('t', 'file /a/b/999.txt missing'),
    );
  });

  it('空白归一：多空格不影响归类', () => {
    expect(failureSignature('t', 'a  b')).toBe(failureSignature('t', 'a b'));
  });

  it('只取代表行：前导的进度输出不影响归类（2026-10-30 降噪）', () => {
    // 真实 pwsh 输出：进度行每次都不同，错误行才是根因
    const noisy = 'Downloading 12%\nDownloading 87%\nError: build failed at step 3';
    const quiet = 'Downloading 41%\nError: build failed at step 3';
    expect(failureSignature('pwsh', noisy)).toBe(failureSignature('pwsh', quiet));
  });

  it('长度截断：超长消息在 120 字处截断（尾部差异不影响）', () => {
    const long = 'x'.repeat(300);
    expect(failureSignature('t', long)).toBe(failureSignature('t', 'x'.repeat(200)));
  });

  it('不同工具同名失败 → 不同签名（窗口分桶之外的二道保险）', () => {
    expect(failureSignature('a', 'same message')).not.toBe(failureSignature('b', 'same message'));
  });
});

describe('createInjectedMessage：注入消息必须带唯一 id（2026-10-30 真机补）', () => {
  it('每次造出的消息都有非空字符串 id', () => {
    const message = createInjectedMessage('hint text');
    expect(typeof message.id).toBe('string');
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.role).toBe('user');
  });

  it('连续两次造的 id 不同（同毫秒也不撞）', () => {
    const a = createInjectedMessage('hint');
    const b = createInjectedMessage('hint');
    expect(a.id).not.toBe(b.id);
  });

  it('批量造 50 条 → id 两两不同（宿主 inbox 按 id 去重，重复即被拒）', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(createInjectedMessage('hint').id);
    expect(ids.size).toBe(50);
  });

  it('内容与来源形状正确', () => {
    const message = createInjectedMessage('the hint');
    expect(message.content).toEqual([{ type: 'text', text: 'the hint' }]);
    expect(message.source.kind).toBe('plugin:clis');
  });
});

/** 引用常量，避免测试里复制文案（文案改了这里会先红）。 */
function HINT(tone: HintTone = 'repeated'): string {
  // 与 intervene.ts 同源：直接调一次 shouldIntervene 拿真值。
  // 用真实逻辑而非复制字符串 —— 文案改了这里会先红。
  if (tone === 'escalating') {
    const state = createInterveneState();
    // 同一签名连撞 3 次：第 2 次触发 repeated，第 3 次窗口内计数到 3
    // 但 signature 已去重，故先 markToolUsed 再撞一次拿 escalating。
    shouldIntervene(state, 'seed', 't', SEM_FAILURE, T0);
    shouldIntervene(state, 'seed', 't', SEM_FAILURE, T0 + 1);
    markToolUsed(state, 'seed');
    return shouldIntervene(state, 'seed', 't', SEM_FAILURE, T0 + 2)!;
  }
  const state = createInterveneState();
  shouldIntervene(state, 'seed', 't', SEM_FAILURE, T0);
  return shouldIntervene(state, 'seed', 't', SEM_FAILURE, T0 + 1)!;
}
