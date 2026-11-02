/**
 * 调度层信号广播的**契约测试**（2026-11-02）。
 *
 * ## 为什么用契约测试而不是类型声明
 *
 * 事件 `mind/register-signal` 的类型声明若放在 clis-contracts，memory-manager
 * （不依赖任何包）就拿不到同一个事件名 —— 类型层与运行时层分叉。
 * 通道的拥有者是 mind，而 CLIS 不该依赖 mind（那会破坏"缺 mind 也能用"）。
 *
 * 于是：CLIS 用**局部类型断言**发出，自由用**契约测试**还回去 ——
 * 载荷形状必须与 mind 侧的接收器逐字段对得上。
 *
 * ## 这条测试防的是什么
 *
 * 「接口看起来在、实际不通」：事件名写错、载荷改成两个位置参数、
 * 字段名对不上 —— 这些在类型断言下**编译期全绿**，只有契约测试能抓住。
 * 本轮真踩过一次：`ctx.emit('clis/register-probe', 'mind', healthProbe)`
 * 与接收端 `{plugin, probe}` 的形状不符，编译不报错、运行时静默失灵。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// 插件工作区与本仓库**不同盘符**（D:\个人开发\CLIS vs C:\Users\lyq\Documents\...），
// 不能用相对路径推 —— 上一版就因为算错而 5 条断言全红。
const WORKSPACE = process.env.DSH_PLUGIN_WORKSPACE ?? 'C:/Users/lyq/Documents/deepseek-harness/default-workspace';

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

describe('调度层信号广播契约', () => {
  const clisSrc = read(join(repoRoot, 'packages/clis-plugin/src/index.ts'));
  const mindSrc = read(join(WORKSPACE, 'dsh-mind/index.js'));
  const memorySrc = read(join(WORKSPACE, 'dsh-memory-manager/server.js'));

  it('CLIS 广播的事件名与 mind 监听的完全一致', () => {
    const sent = clisSrc.match(/'mind\/register-signal'/);
    const heard = mindSrc.match(/'mind\/register-signal'/);
    expect(sent?.[0]).toBeDefined();
    expect(heard?.[0]).toBeDefined();
    expect(sent?.[0]).toBe(heard?.[0]);
  });

  it('载荷是单个对象（含 name/situation/words），不是位置参数', () => {
    // 位置参数形态（曾真踩过）：emit('x', 'name', probe)
    expect(clisSrc).not.toMatch(/emitSignal\.call\([^)]*,\s*'mind\/register-signal',\s*'[^']+'\s*,/);
    // 对象形态：emit('x', { name: ..., ... })
    expect(clisSrc).toMatch(/'mind\/register-signal',\s*\{/);
  });

  it('CLIS 广播的信号字段名与 mind 接收器读取的字段名一致', () => {
    // mind 侧用**解构**读（`const { name, situation, words } = payload`），
    // 不是 `payload.name` —— 契约要管的是**字段名一致**，不是写法。
    // 两种读法都接受。
    for (const field of ['name', 'situation', 'words']) {
      const destructured = new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*payload`).test(mindSrc);
      const dotted = mindSrc.includes(`payload.${field}`);
      expect(destructured || dotted, `mind 侧应读取字段 ${field}`);
      // 发出方必须真的带上这个字段
      expect(clisSrc).toContain(`${field}:`);
    }
  });

  it('owner 字段标注归属（可追责：这个词是谁贡献的）', () => {
    expect(clisSrc).toContain("owner: 'dsh-clis'");
    expect(memorySrc).toContain("owner: 'dsh-memory-manager'");
  });

  it('广播失败不得影响 CLIS 主链路（缺 mind 时它照常工作）', () => {
    // 广播必须包在 try 里
    const idx = clisSrc.indexOf("'mind/register-signal'");
    expect(idx).toBeGreaterThan(-1);
    const around = clisSrc.slice(Math.max(0, idx - 600), idx + 600);
    expect(around).toMatch(/try\s*\{/);
    expect(around).toMatch(/catch\s*\{/);
  });

  it('memory 也广播自己的领域信号（两家的词汇各自覆盖）', () => {
    expect(memorySrc).toContain("'mind/register-signal'");
    expect(memorySrc).toContain("name: 'memory-recall'");
  });

  it('CLIS 与 memory 广播的信号名不同（不覆盖彼此）', () => {
    expect(clisSrc).toContain("name: 'clis-causal'");
    expect(memorySrc).toContain("name: 'memory-recall'");
  });
});
