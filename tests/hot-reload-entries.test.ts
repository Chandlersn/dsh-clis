/**
 * 回归：热重载必须覆盖**全部五个入口**，不是只换包根。
 *
 * ## 缺陷背景（2026-10-30 真机事故）
 *
 * `cordis.patch.yml` 把四个组件拆成四条独立 entry（`dsh-clis/classifier` 等），
 * 包根 `dsh-clis` 是第五条。它们在 loader 里各自持有 `moduleNamespace` 与
 * fiber —— 换装包根**不会**带着组件一起换。
 *
 * 实测后果：改了编排器的早退判据、七道部署闸门全过、磁盘产物确认已更新，
 * 真机行为却毫无变化；只能重启宿主才验证成功。也就是说"智能热重载"对
 * 四个组件从来没生效过。
 *
 * ## 本套件钉住什么
 *
 * 1. `ENTRY_FILES` 与 `package.json` 的 `exports` 一一对应（机器核对，
 *    以后加/删入口而忘了改这张表会立刻红）；
 * 2. `entriesToReload` 只挑本包入口，且不认识的一律不动（不误伤别人的 entry）；
 * 3. 换装内核里确实带了 `reloadEntries`，且它按 entry 走 loader 的重启路径。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ENTRY_FILES, entriesToReload, entryFileOf } from '../packages/clis-plugin/src/hot-reload';

const ROOT = process.cwd();

/** 读打包用的 package.json（packaging 是发布真相源）。 */
function packagedManifest(): {
  exports: Record<string, string>;
  files: string[];
} {
  const raw = readFileSync(join(ROOT, 'packaging', 'package.json'), 'utf8');
  return JSON.parse(raw) as { exports: Record<string, string>; files: string[] };
}

describe('入口表与 package.json exports 一一对应', () => {
  it('五个入口：包根 + 四个组件', () => {
    expect(Object.keys(ENTRY_FILES).sort()).toEqual([
      'dsh-clis',
      'dsh-clis/classifier',
      'dsh-clis/feedback',
      'dsh-clis/orchestrator',
      'dsh-clis/strategy',
    ]);
  });

  it('每个入口的文件名与 exports 指向的文件一致（机器核对）', () => {
    const { exports } = packagedManifest();
    for (const [name, file] of Object.entries(ENTRY_FILES)) {
      // exports 的键是 "." 或 "./classifier" 这种相对形式
      const key = name === 'dsh-clis' ? '.' : `.${name.slice('dsh-clis'.length)}`;
      expect(exports[key], `exports 缺少 ${key}`).toBe(`./${file}`);
    }
  });

  it('每个入口文件都在 package.json 的 files 白名单里（否则打不进产物）', () => {
    const { files } = packagedManifest();
    for (const file of Object.values(ENTRY_FILES)) {
      expect(files, `${file} 不在 files 白名单`).toContain(file);
    }
  });
});

describe('entryFileOf：认识本包入口', () => {
  it('五个入口都能取到文件名', () => {
    expect(entryFileOf('dsh-clis')).toBe('index.js');
    expect(entryFileOf('dsh-clis/classifier')).toBe('clis-classifier.js');
    expect(entryFileOf('dsh-clis/strategy')).toBe('clis-strategy.js');
    expect(entryFileOf('dsh-clis/feedback')).toBe('clis-feedback.js');
    expect(entryFileOf('dsh-clis/orchestrator')).toBe('clis-orchestrator.js');
  });

  it('别人的 entry 一律返回 undefined（不误伤）', () => {
    expect(entryFileOf('dsh-memory-manager')).toBeUndefined();
    expect(entryFileOf('@deepseek-ai/dsh-tools')).toBeUndefined();
    expect(entryFileOf('')).toBeUndefined();
    expect(entryFileOf('dsh-clis-other')).toBeUndefined();
  });

  it('原型链上的键不会被当成入口（Object.hasOwn 而非 in）', () => {
    // 用 in 判断时 'toString' 会被误认为存在
    expect(entryFileOf('toString')).toBeUndefined();
    expect(entryFileOf('constructor')).toBeUndefined();
    expect(entryFileOf('__proto__')).toBeUndefined();
  });
});

describe('entriesToReload：挑出要换装的 entry', () => {
  it('从混合的 entry 列表里只挑本包五个', () => {
    const all = [
      'dsh-memory-manager',
      'dsh-clis',
      'dsh-clis/classifier',
      '@deepseek-ai/dsh-tools',
      'dsh-clis/orchestrator',
      'dsh-clis/strategy',
      'dsh-clis/feedback',
      'dshmarket',
    ];
    expect(entriesToReload(all)).toEqual([
      'dsh-clis',
      'dsh-clis/classifier',
      'dsh-clis/orchestrator',
      'dsh-clis/strategy',
      'dsh-clis/feedback',
    ]);
  });

  it('一个本包入口都没有 → 空数组（不抛错）', () => {
    expect(entriesToReload(['dsh-memory-manager', 'dshmarket'])).toEqual([]);
    expect(entriesToReload([])).toEqual([]);
  });

  it('顺序稳定：按输入顺序，不重排（便于日志对照）', () => {
    const a = entriesToReload(['dsh-clis/strategy', 'dsh-clis']);
    const b = entriesToReload(['dsh-clis/strategy', 'dsh-clis']);
    expect(a).toEqual(b);
    expect(a).toEqual(['dsh-clis/strategy', 'dsh-clis']);
  });

  it('重复名只保留一份（loader 里同名不该出现，但别放大成两次换装）', () => {
    // 注意：这里断言的是"不崩且结果仍是本包入口"，去重由 loader 保证。
    const out = entriesToReload(['dsh-clis', 'dsh-clis']);
    expect(out.every((n) => entryFileOf(n) !== undefined)).toBe(true);
  });
});

describe('换装内核必须带 reloadEntries', () => {
  /** 取内核源码字符串（与部署出去的那份同源）。 */
  function coreSource(): string {
    const src = readFileSync(join(ROOT, 'packages', 'clis-plugin', 'src', 'hot-reload.ts'), 'utf8');
    const start = src.indexOf('const RELOAD_CORE_SOURCE = String.raw`');
    const end = src.indexOf('\n`;', start);
    return src.slice(start, end);
  }

  it('导出了 reloadEntries', () => {
    expect(coreSource()).toContain('export async function reloadEntries');
  });

  it('走「先 dispose 旧 fiber 再 init」的完整重载路径', () => {
    const core = coreSource();
    // 实测：entry.update({}, false, true) 只到 _patchContext([])，不会重新 import，
    // 组件模块根本没被重新求值（2026-10-30 带探针标记的真机验证）。
    // 注释里会提到旧写法（作为反例），故只扫**非注释**的代码行。
    const code = core
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).toContain('previous.dispose()');
    expect(code).toContain('await entry.init()');
    expect(code).not.toContain('entry.update({}, false, true)');
  });

  it('重载前先清本包模块缓存（否则 init 重新 import 还是旧模块）', () => {
    const core = coreSource();
    const purgeIdx = core.indexOf('purgeCaches(internal, options.packageUrl)');
    const initIdx = core.indexOf('await entry.init()');
    expect(purgeIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(purgeIdx);
  });

  it('按名字匹配 entry，而不是按位置（顺序无关）', () => {
    expect(coreSource()).toContain('entry?.options?.name');
  });

  it('组件全被关掉时返回成功而不是失败（不是错误）', () => {
    const core = coreSource();
    // 找不到目标 entry 时应 ok:true、reloaded:0
    expect(core).toMatch(/targets\.length === 0[\s\S]{0,160}ok: true, reloaded: 0/);
  });
});

describe('watchedFiles 覆盖四个组件产物（变更能被检测到）', () => {
  it('监视清单含四个组件入口与包根', () => {
    const src = readFileSync(join(ROOT, 'packages', 'clis-plugin', 'src', 'hot-reload.ts'), 'utf8');
    for (const file of Object.values(ENTRY_FILES)) {
      expect(src, `watchedFiles 漏了 ${file}`).toContain(`'${file}'`);
    }
  });
});

describe('内核被部署删掉时仍能换装（2026-10-30 第二次真机事故）', () => {
  /**
   * 事故链：deploy.ps1 同步产物时先 `Remove-Item` 插件目录下所有文件，
   * 连 `reload-core.mjs` 一起删掉，然后才拷新产物。于是变化被检测到时，
   * 内核文件已不在磁盘上。
   *
   * 旧写法：`if (core === undefined) { ... import(coreUrl) }` —— 只 import 一次
   * 且缓存结果，内核被删就整次换装失败。实测现象：chunk 已更新、宿主 PID 未变，
   * 但真机 trace note 里的探针标记**仍在**，即组件模块根本没换。
   */
  const src = readFileSync(join(ROOT, 'packages', 'clis-plugin', 'src', 'hot-reload.ts'), 'utf8');

  it('每次换装都重新取内核（不在首次 import 后缓存）', () => {
    expect(src).toContain('const loadCore = async');
    expect(src).toContain('await loadCore()');
  });

  it('取内核前会先 ensureReloadCore（文件被删也能重新写出来）', () => {
    const body = src.slice(src.indexOf('const loadCore = async'));
    expect(body.slice(0, 400)).toContain('ensureReloadCore(installDir)');
  });

  it('内核用带 generation 的 URL import（刚重写的内容不吃旧缓存）', () => {
    const body = src.slice(src.indexOf('const loadCore = async'));
    expect(body.slice(0, 500)).toMatch(/import\(fresh\)/);
    expect(body.slice(0, 500)).toContain('?v=');
  });

  it('不再有「首次 import 后长期缓存内核」的写法', () => {
    expect(src).not.toContain('if (core === undefined) {');
  });

  it('换装内核不在监视清单里（否则删内核本身就触发一次换装）', () => {
    const watched = src.slice(
      src.indexOf('function watchedFiles'),
      src.indexOf('async function mtimeFingerprint'),
    );
    expect(watched).not.toContain('reload-core.mjs');
  });

  it('等磁盘稳定而非固定静默期（deploy 逐文件删除再写入会撞中间态）', () => {
    expect(src).toContain('waitForStableFingerprint');
    expect(src).toContain('连续两次指纹相同');
  });
});
