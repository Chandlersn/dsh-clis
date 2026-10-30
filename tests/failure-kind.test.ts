/**
 * 回归：失败**性质**分类 —— 决定这次失败值不值得用因果结构介入。
 *
 * ## 为什么有这一层（2026-10-30 真实会话转录复算）
 *
 * 71 个会话 / 1186 条真实失败回放进旧闸门，触发 41 次，拆开看：
 * INFRA 15、SEM 17、MECH 9 —— **59% 的火力打在无关的地方**。
 *
 * 提示文案讲的是"回路会越修越弹、对偶会一边修一边被拉回去"：
 * - 对 `old_string was not found` 既不对题也不可执行（该做的是先读文件）
 * - 对 `web fetch failed` 是纯噪音（该做的是重试）
 *
 * 真正属于因果结构判断该管的只有 SEM 类，占全部失败的 1.4%。
 *
 * ## 本套件的判据
 *
 * 逐条拿**真实会话里出现过的失败原文**断言分类，不是编造的样例 ——
 * 样例来自 `~/.dsh/sessions` 的 tool/result 转录。
 */
import { describe, expect, it } from 'vitest';

import {
  FAILURE_KINDS,
  classifyFailureKind,
  worthCausalIntervention,
} from '../packages/clis-plugin/src/failure-kind';

describe('分类取值域', () => {
  it('恰好三种性质', () => {
    expect([...FAILURE_KINDS]).toEqual(['MECH', 'INFRA', 'SEM']);
  });

  it('只有 SEM 值得因果介入', () => {
    expect(worthCausalIntervention('SEM')).toBe(true);
    expect(worthCausalIntervention('MECH')).toBe(false);
    expect(worthCausalIntervention('INFRA')).toBe(false);
  });
});

describe('MECH：换个参数就能过，不该判因果', () => {
  // 全部来自真实转录
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['edit', 'Error: cannot modify "D:\\x\\client.js": file has not been read — read the file, then retry'],
    ['edit', 'Error: old_string was not found in "C:\\x\\src\\client.ts"'],
    ['edit', 'Error: old_string matched 2 times in "C:\\x\\README.md"; provide a more specific old_string'],
    ['write', 'Error: invalid arguments: missing required property "file_path"'],
    ['pwash', 'Error: unknown tool "pwash"'],
    ['edit', 'Error: invalid escalation: justification is only valid together with sandbox_permissions'],
    ['pwsh', 'Select-String : Cannot find path \'D:\\dsh\\x.js\' because it does not exist.'],
    ['pwsh', "[stderr] At line:1 char:388 + ~~~ Variable reference is not valid. ':' was not followed by a valid variable name"],
  ];

  for (const [tool, message] of cases) {
    it(`${tool}: ${message.slice(0, 46)}…`, () => {
      expect(classifyFailureKind(tool, message)).toBe('MECH');
    });
  }
});

describe('INFRA：宿主/网络/审查器故障，判因果是空转', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['pwsh', 'Error: Auto review of tool "pwsh" failed; its body was not executed: Unexpected token \'<\''],
    ['plugin_manager', 'Error: Auto review of tool "plugin_manager" failed; its body was not executed'],
    ['memory_check', 'Error: tool "memory_check" returned invalid output: "value.results[1].level" must be one of ["WARN","FAIL"]'],
    ['memory_insight', 'Error: tool "memory_insight" returned invalid output: value is not lossless JSON'],
    ['clis_run', 'Error: cannot get property "storageDomain" without inject'],
    ['web_fetch', 'Error: web fetch failed: TypeError: fetch failed'],
    ['grep', 'Error: tool call timed out after 30000ms'],
    ['cordis_inspect_query', 'Error: Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 10000ms'],
    ['pwsh', 'The tool call was interrupted after it was recorded, but no result was durably recorded.'],
    ['pwsh', 'hook never ran'],
    ['pwsh', 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\x)'],
  ];

  for (const [tool, message] of cases) {
    it(`${tool}: ${message.slice(0, 46)}…`, () => {
      expect(classifyFailureKind(tool, message)).toBe('INFRA');
    });
  }
});

describe('SEM：方法/假设/判据有问题 —— 这才是 CLIS 的战场', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['pwsh', 'TSC_EXIT=0\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 25 passed'],
    ['pwsh', 'not ok 3 - 宿主集成：插件装起来之后真的能用'],
    ['pwsh', '语法 OK\n立体声宽度 0.3 (=单声道, >0.3 有宽度)\n判断依据：高频占比 >15% 判为单声道'],
    ['pwsh', '[stderr] node : 没拿到逐帧差分数据'],
    ['pwsh', 'Error: 版面校验失败：主标与配图重叠 9px'],
    ['pwsh', 'AssertionError: expected 3 to equal 5'],
    ['pwsh', 'Error: build failed: module not found in bundle graph'],
  ];

  for (const [tool, message] of cases) {
    it(`${tool}: ${message.slice(0, 46)}…`, () => {
      expect(classifyFailureKind(tool, message)).toBe('SEM');
    });
  }
});

describe('判据的边界', () => {
  it('空消息归 SEM（宁可多说一句，也不吞掉真正该管的）', () => {
    expect(classifyFailureKind('pwsh', '')).toBe('SEM');
    expect(classifyFailureKind('', '')).toBe('SEM');
  });

  it('INFRA 优先于 MECH：插件返回非法输出里夹带 does not exist 仍是设施问题', () => {
    // 真实形状：宿主的输出校验失败，正文里恰好含 "does not exist"
    const message =
      'Error: tool "x" returned invalid output: field does not exist in schema';
    expect(classifyFailureKind('memory_check', message)).toBe('INFRA');
  });

  it('工具名参与判据（同一段文案在不同工具下含义不同）', () => {
    // "unknown tool" 出现在任何工具里都是参数/名称问题
    expect(classifyFailureKind('pwsh', 'unknown tool')).toBe('MECH');
  });

  it('判定是纯函数：同一输入多次调用结果相同', () => {
    const message = 'AssertionError: expected 1 to equal 2';
    expect(classifyFailureKind('pwsh', message)).toBe(classifyFailureKind('pwsh', message));
  });
});

describe('闸门效果（真实分布口径）', () => {
  it('三类各占一份时，只有 SEM 那一份能穿过闸门', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['edit', 'Error: old_string was not found in "a.ts"'],
      ['web_fetch', 'Error: web fetch failed: TypeError: fetch failed'],
      ['pwsh', 'Tests 3 failed | 12 passed'],
    ];
    const passing = samples.filter(([tool, message]) =>
      worthCausalIntervention(classifyFailureKind(tool, message)),
    );
    expect(passing).toHaveLength(1);
    expect(passing[0]?.[1]).toContain('Tests 3 failed');
  });
});
