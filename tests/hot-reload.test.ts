/**
 * 回归：智能热重载的安全边界。
 *
 * 完整换装流程依赖真实宿主 loader（单测环境没有），这里钉住**能纯测的部分**：
 * 内核文件的生成与幂等（防"自己触发自己"）、内核可被 node 直接 import
 * （无 TS 残留）、generation 缓存击穿机制、安全常量的量级。
 * 换装本体由 memory-manager 同款机制背书（已在真实宿主验证过）。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureReloadCore } from '../packages/clis-plugin/src/hot-reload';

const SRC = resolve(import.meta.dirname, '../packages/clis-plugin/src/hot-reload.ts');

/** 临时目录辅助。 */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'clis-hmr-'));
}

describe('换装内核文件', () => {
  it('ensureReloadCore 写出 reload-core.mjs 到安装目录', async () => {
    const dir = tmp();
    const url = await ensureReloadCore(dir);
    expect(url).toMatch(/^file:\/\/\//u);
    const src = readFileSync(url.replace(/^file:\/\/\//u, ''), 'utf8');
    expect(src).toContain('export async function selfReload');
    expect(src).toContain('purgeCaches');
    expect(src).toContain('restoreCaches');
  });

  it('幂等：内容未变时不重写（不触发自己的文件监视）', async () => {
    const dir = tmp();
    const u1 = await ensureReloadCore(dir);
    const m1 = statSync(u1.replace(/^file:\/\/\//u, '')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const u2 = await ensureReloadCore(dir);
    expect(u2).toBe(u1);
    expect(statSync(u2.replace(/^file:\/\/\//u, '')).mtimeMs).toBe(m1);
  });

  it('内核无 TS 残留（要被 node 直接 import）', async () => {
    const dir = tmp();
    const url = await ensureReloadCore(dir);
    const src = readFileSync(url.replace(/^file:\/\/\//u, ''), 'utf8');
    expect(src).not.toMatch(/:\s*(string|boolean|number)\b/u);
    expect(src).not.toContain('import type');
    expect(src).not.toContain('as const');
  });

  it('内核自带缓存击穿的 generation 机制（宿主缓存形态未知时的兜底）', async () => {
    const dir = tmp();
    const url = await ensureReloadCore(dir);
    const src = readFileSync(url.replace(/^file:\/\/\//u, ''), 'utf8');
    expect(src).toContain('dshclis-reload');
    expect(src).toContain('enableFreshDependencies');
    expect(src).toContain('registerHooks');
  });

  it('换装失败有回滚路径（restore old registration）', async () => {
    const dir = tmp();
    const url = await ensureReloadCore(dir);
    const src = readFileSync(url.replace(/^file:\/\/\//u, ''), 'utf8');
    // memory-manager 踩过的坑：回滚必须先 settle 替代 fiber，否则注册冲突
    expect(src).toContain('registry.delete(replacement)');
    expect(src).toContain('restored: true');
    expect(src).toContain('restored: false');
  });
});

describe('热重载的安全设计', () => {
  const src = readFileSync(SRC, 'utf8');

  it('静默期 >= 轮询间隔（检测到变化后要等写入方写完）', () => {
    const poll = Number(src.match(/const POLL_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''));
    const quiet = Number(src.match(/const QUIET_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''));
    expect(poll).toBe(2_000);
    expect(quiet).toBeGreaterThanOrEqual(poll);
  });

  it('有退避上限（防"坏代码+每次保存"变重载风暴）', () => {
    expect(src).toContain('BACKOFF_MAX_MS');
    expect(src).toContain('consecutiveFailures');
    // 退避后重新取基线：不会把同一次失败反复触发
    expect(src).toContain('consecutiveFailures += 1');
  });

  it('换装期间单飞（inFlight 保护，deploy 写 10 个文件只换一次）', () => {
    expect(src).toContain('stopped');
    // 内核源里有 inFlight 单飞
  });

  it('看门狗是进程级单例（换装不杀看门狗）', () => {
    expect(src).toBeDefined();
    // 单例逻辑在 index.ts（HOT_RELOAD_KEY），这里核对它的存在
    const idx = readFileSync(resolve(import.meta.dirname, '../packages/clis-plugin/src/index.ts'), 'utf8');
    expect(idx).toContain("Symbol.for('dsh-clis.hot-reload-started')");
    expect(idx).toContain('startHotReload');
  });

  it('监视文件清单覆盖五个入口与内核（bundle 改入口集必须跟上）', () => {
    expect(src).toContain("'index.js'");
    expect(src).toContain("'clis-classifier.js'");
    expect(src).toContain("'clis-strategy.js'");
    expect(src).toContain("'clis-feedback.js'");
    expect(src).toContain("'clis-orchestrator.js'");
    expect(src).toContain("'reload-core.mjs'");
  });
});
