/**
 * 智能热重载 —— 改了代码**自动**换上，无需重启宿主、无需按钮。
 *
 * ## 组成
 *
 * **A. 自换内核（borrowReloadCore）**：机制照搬 memory-manager 的
 * `src/reload.js`（其本身源自 dsh-our-free-model 2.5.3，与内核 HMR 同一套
 * 公开原语）：快照活 fiber → 清本包 ESM/CJS 缓存 → 经宿主 loader 重导入 →
 * 逐 fiber 换注册；失败恢复缓存并回滚旧注册。原实现是**面板按钮触发**
 * （POST /reload，有人在看结果）；这里改成文件监视触发，所以对它有两条
 * 硬要求，原实现天然满足：
 *
 * - **可重入保护**：`inFlight` 单飞 —— deploy.ps1 保存 10 个 JS 时只触发
 *   一次换装，不会 10 个文件 10 次；
 * - **回滚完整**：新代码 apply 抛错 → 恢复缓存 + 回滚旧注册；
 *   回滚本身失败才要求重启（状态不会更糟）。
 *
 * **B. 文件监视（watchLoop）**：为什么不用宿主 dsh-hmr——本会话实测
 * profile hmr.root 指向本包安装目录后，改文件日志零反应（5 入口共享
 * 5 chunk，partialReload 的依赖条件不满足）。也为什么不用 fs.watch——
 * Windows 上编辑器"先删后写"会触发两条假事件。这里用 **2s 一次的
 * mtime 轮询**：对开发节奏足够快；零假事件；不持文件句柄；deploy 全量
 * 重写目录时天然合并为一次换装。
 *
 * ## 安全边界（自动触发比按钮激进，边界必须更硬）
 *
 * - **静默期**：检测到变化后等 2s 再换——deploy 逐文件写、编辑器原子替换
 *   都有时间窗，早换会装上"写了一半"的目录；
 * - **单飞**：换装期间忽略一切新变化，换完再重新读 mtime 基线；
 * - **连续失败退避**：新代码 apply 连续抛错时，逐次放大间隔（4s→…→120s），
 *   防止"坏代码 + 每次保存"变成重载风暴；一旦成功即复位；
 * - **只读安装目录**：只监视部署产物，不碰源码仓库；
 * - **状态全在磁盘**：CLIS 的 history/指标/收件箱/去重状态本来就不在
 *   进程里，换装零状态丢失。
 */
import { stat } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';

/** 轮询间隔（毫秒）。 */
const POLL_MS = 2_000;
/** 检测到变化后的静默期：等写入方写完。 */
const QUIET_MS = 2_000;
/** 连续失败退避的上限。 */
const BACKOFF_MAX_MS = 120_000;

/**
 * 照搬 memory-manager reload.js 的换装内核。
 *
 * 刻意 **JS 而非 TS**：这段要被 `import(带 generation query 的 URL)` 重新
 * 求值——TS 打包进 bundle 后它就在缓存里，purge 也拿不到"新代码"。
 * 放在 packaging/ 里随产物部署，从**安装目录**动态 import，才能保证每次
 * 读到磁盘上的最新版。
 */
const RELOAD_CORE_SOURCE = String.raw`
// 智能热重载内核 —— 照搬 memory-manager src/reload.js（源自 dsh-our-free-model
// 2.5.3，与内核 HMR 同一套公开原语）。详见该文件头注释。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

let inFlight = null;
const hooksKey = Symbol.for('dsh-clis.reload-hooks');
const reloadHooks = (globalThis[hooksKey] ??= new Map());

function enableFreshDependencies(packageUrl) {
	if (reloadHooks.has(packageUrl)) return;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved;
			const generation = new URL(context.parentURL).searchParams.get('dshclis-reload');
			if (generation === null) return resolved;
			const target = new URL(resolved.url);
			target.searchParams.set('dshclis-reload', generation);
			return { ...resolved, url: target.href };
		},
	});
	reloadHooks.set(packageUrl, hook);
}

export function purgeCaches(internal, packageUrl) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache !== null && cache !== undefined && typeof cache.keys === 'function' && typeof cache.get === 'function' && typeof cache.delete === 'function') {
		const read = (key) => { try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } } };
		const drop = (key) => {
			try { Map.prototype.delete.call(cache, key); return; } catch { /* not a real Map */ }
			try { cache.delete(key); } catch { /* best effort */ }
		};
		for (const key of packageCacheKeys(cache, packageUrl)) {
			backup.esm.set(key, read(key));
			drop(key);
		}
	}
	const req = createRequire(import.meta.url);
	for (const key of backup.esm.keys()) {
		try {
			const filePath = fileURLToPath(key);
			if (req.cache[filePath] !== undefined) {
				backup.cjs.set(filePath, req.cache[filePath]);
				delete req.cache[filePath];
			}
		} catch { /* non-file URL */ }
	}
	return backup;
}

function packageCacheKeys(cache, packageUrl) {
	const keys = [];
	for (const key of cache.keys()) {
		if (typeof key === 'string' && key.startsWith(packageUrl)) keys.push(key);
	}
	return keys;
}

export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* best effort */ } }
	}
	const req = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) req.cache[filePath] = module;
}

export async function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const packageUrl = options.packageUrl;
		const entryUrl = options.entryUrl;
		const loader = ctx.loader;
		const registry = ctx.registry;
		if (loader === undefined || registry === undefined) {
			return { ok: false, error: '本宿主没有 loader/registry', restored: false };
		}
		const previous = ctx.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: '没有可重载的 runtime', restored: false };
		}
		const runtime = registry.get(previous);
		const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
			const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
			const plugin = typeof previous === 'function' ? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name } : previous;
			return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config };
		});
		if (fibers.length === 0) return { ok: false, error: 'runtime 没有活纤维', restored: false };

		const internal = loader.internal;
		const backup = purgeCaches(internal, packageUrl);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
			if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
				enableFreshDependencies(packageUrl);
				const freshUrl = new URL(entryUrl);
				freshUrl.searchParams.set('dshclis-reload', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
				replacement = await importFresh(freshUrl.href);
				if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
				if (replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
					throw new Error('cache invalidation 后拿到的仍是旧插件');
				}
			}
		} catch (error) {
			restoreCaches(internal, backup);
			return { ok: false, error: String(error?.message ?? error), restored: true };
		}

		try {
			registry.delete(previous);
			await Promise.allSettled(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			logger.warn?.('clis: hot reload dispose reported ' + String(error?.message ?? error));
		}
		try {
			const created = [];
			for (const { fiber, entry, config } of fibers) {
				const registered = fiber.parent.registry.plugin(replacement, config);
				const fresh = registered.ctx.fiber;
				if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
				created.push(fresh);
			}
			await Promise.allSettled(created.map((fiber) => fiber.await()));
			return { ok: true, fibers: created.length };
		} catch (error) {
			restoreCaches(internal, backup);
			try {
				const gone = registry.delete(replacement);
				const replacementFibers = gone?.fibers ?? gone?.runtime?.fibers;
				if (replacementFibers) await Promise.allSettled([...replacementFibers].map((f) => f.await()));
			} catch { /* may never have started */ }
			try {
				const restored = [];
				for (const { fiber, entry, plugin, config } of fibers) {
					const registered = fiber.parent.registry.plugin(plugin, config);
					const fresh = registered.ctx.fiber;
					if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
					restored.push(fresh);
				}
				await Promise.allSettled(restored.map((fiber) => fiber.await()));
				return { ok: false, error: String(error?.message ?? error), restored: true };
			} catch (restoreError) {
				return { ok: false, error: String(restoreError?.message ?? restoreError), restored: false };
			}
		}
	})();
	return inFlight.finally(() => { inFlight = null; });
}

/**
 * 按 entry 换装（四个组件各一条 entry，只换包根换不到它们）。
 *
 * 走 loader 自己的重启路径：entry.update({}, false, true) —— force 让它在
 * options 未变时也触发 partial-dispose → 重新 import → 按 moduleNamespace
 * 换注册。与宿主 HMR 同一条路径，比自己手搓 fiber 更不容易漏。
 *
 * 某条 entry 不存在（用户关了组件）就跳过，不算失败。
 *
 * @param ctx 插件上下文（需要 loader）。
 * @param options.packageUrl 本包目录的 file:// URL（带尾斜杠）。
 * @param options.entries [{ name, file }]：要换装的入口。
 * @param options.logger 日志。
 * @returns { ok, reloaded, error? }。
 */
export async function reloadEntries(ctx, options = {}) {
	const logger = options.logger ?? console;
	const loader = ctx.loader;
	if (loader === undefined || typeof loader.entries !== 'function') {
		return { ok: false, error: '本宿主没有 loader.entries', reloaded: 0 };
	}
	const wanted = new Set((options.entries ?? []).map((item) => item.name));
	if (wanted.size === 0) return { ok: true, reloaded: 0 };

	// 先收集目标 entry（不要边遍历边改，loader 的 entries() 是生成器）。
	const targets = [];
	for (const entry of loader.entries()) {
		const name = entry?.options?.name;
		if (typeof name === 'string' && wanted.has(name)) targets.push(entry);
	}
	if (targets.length === 0) {
		// 组件全被用户关掉了：不是错误。
		return { ok: true, reloaded: 0 };
	}

	// 清本包模块缓存 —— 不清的话 entry.init() 重新 import 拿到的还是旧模块。
	const internal = loader.internal;
	if (internal !== undefined) purgeCaches(internal, options.packageUrl);

	let reloaded = 0;
	for (const entry of targets) {
		try {
			// 为什么要 dispose 再 init，而不是 entry.update({}, false, true)：
			// force 只让 update 走到 _patchContext([])，那一步只更新 config，
			// **不会重新 import 模块** —— 实测 entry.update 之后真机行为毫无变化
			// （2026-10-30：带探针标记的组件已落盘、PID 未变，但 trace note
			// 里没有标记，证明组件模块根本没被重新求值）。
			// 必须先拆掉旧 fiber，再让 loader 走完整的 _init()（import → 换注册）。
			const previous = entry.fiber;
			if (previous !== undefined && previous !== null) {
				previous.dispose();
				try { await previous.await(); } catch { /* 卸载期错误不影响换装 */ }
			}
			await entry.init();
			reloaded += 1;
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error), reloaded };
		}
	}
	logger.info?.('clis: 已换装 ' + reloaded + ' 个组件入口');
	return { ok: true, reloaded };
}
`;

/**
 * 把内核写成安装目录下的 `reload-core.mjs`，返回它的 URL。
 *
 * 幂等：内容未变不重写（避免自己触发自己的文件监视）。
 *
 * @param installDir 安装目录（bundle 所在处）。
 * @returns 内核模块的 file:// URL。
 */
export async function ensureReloadCore(installDir: string): Promise<string> {
  const target = pathJoin(installDir, 'reload-core.mjs');
  try {
    const existing = await readFile2(target);
    if (existing === RELOAD_CORE_SOURCE) return fileUrl(target);
  } catch {
    /* first run */
  }
  const { writeFile: writeFile2, mkdir } = await import('node:fs/promises');
  await mkdir(installDir, { recursive: true });
  await writeFile2(target, RELOAD_CORE_SOURCE, 'utf8');
  return fileUrl(target);
}

/** 读文件文本；不存在时抛错由调用方处理。 */
async function readFile2(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

/** 路径 → file:// URL。 */
function fileUrl(path: string): string {
  // Windows 路径 → file:///D:/...
  return 'file:///' + path.replace(/\\/gu, '/').replace(/^\//u, '');
}

/**
 * 安装目录里被监视的文件集合（**只监视产物，不监视换装内核本身**）。
 *
 * ## 为什么排除 reload-core.mjs（2026-10-30 真机事故）
 *
 * `deploy.ps1` 同步产物时先删目录下所有文件、再拷新产物。若把内核也纳入
 * 指纹，删除内核这件事本身就构成一次"变化"，轮询可能在 deploy 只做了一半时
 * 就触发换装 —— 此时 `loadCore()` 会把内核重新写出来，随后 deploy 又把它删掉，
 * 于是 import 失败、整次换装作废。实测：第一次部署能换装成功，紧接着第二次
 * 部署就静默失败，真机探针标记撤不掉。
 *
 * 内核是**换装机制自己的工具文件**，不是被监视的产物：它的内容由
 * `ensureReloadCore` 保证，每次换装前都会确认。
 */
function watchedFiles(installDir: string): string[] {
  return [
    'index.js',
    'clis-classifier.js',
    'clis-strategy.js',
    'clis-feedback.js',
    'clis-orchestrator.js',
  ].map((name) => pathJoin(installDir, name));
}

/**
 * 本包在 loader 里的五个入口：**模块说明符 → 文件名**。
 *
 * ## 为什么必须按入口逐个换装（2026-10-30 真机发现）
 *
 * `cordis.patch.yml` 把四个组件拆成**四条独立 entry**（`dsh-clis/classifier`
 * 等），包根 `dsh-clis` 是第五条。它们在 loader 里各自持有 `moduleNamespace`
 * 与 fiber —— 换装包根**不会**带着组件一起换。
 *
 * 实测后果：改了 `clis-orchestrator` 的早退判据、部署脚本七道闸门全过、
 * 磁盘产物确认已更新，真机行为却毫无变化 —— 因为只有包根那条 entry 换了，
 * 编排器跑的还是旧模块。当时只能重启宿主才发现问题。
 *
 * 这张表就是"换装要覆盖哪些入口"的单一真值源：它与 `package.json` 的
 * `exports` 必须一一对应（`tests/hot-reload-entries.test.ts` 机器核对）。
 */
export const ENTRY_FILES: Readonly<Record<string, string>> = {
  'dsh-clis': 'index.js',
  'dsh-clis/classifier': 'clis-classifier.js',
  'dsh-clis/strategy': 'clis-strategy.js',
  'dsh-clis/feedback': 'clis-feedback.js',
  'dsh-clis/orchestrator': 'clis-orchestrator.js',
};

/**
 * 该入口对应的文件名；不是本包入口时返回 undefined。
 *
 * @param name loader entry 的模块说明符（`entry.options.name`）。
 * @returns bundle 里的文件名，或 undefined。
 */
export function entryFileOf(name: string): string | undefined {
  return Object.hasOwn(ENTRY_FILES, name) ? ENTRY_FILES[name] : undefined;
}

/**
 * 从一组 entry 名里挑出**需要换装**的那些。
 *
 * 纯函数：只做集合运算，不碰 loader。它回答的是"这次换装要动哪几条"，
 * 与"怎么换"分开，便于穷举测试（尤其要覆盖"不认识的 entry 一律不动"）。
 *
 * @param names 当前 loader 里的 entry 名。
 * @returns 属于本包、且顺序稳定的入口名列表。
 */
export function entriesToReload(names: readonly string[]): string[] {
  return names.filter((name) => entryFileOf(name) !== undefined);
}

/**
 * 读取一组文件的 mtime 指纹；任一缺失即视为变化（部署中途）。
 */
async function mtimeFingerprint(installDir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of watchedFiles(installDir)) {
    try {
      const s = await stat(file);
      parts.push(`${file}:${s.mtimeMs}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join('|');
}

/**
 * 等到目录指纹**稳定**（连续两次采样一致）才返回。
 *
 * ## 为什么不能只等一个固定静默期（2026-10-30 真机事故）
 *
 * `deploy.ps1` 是**逐文件**删除再写入：先 `Remove-Item` 全部，再逐个拷贝。
 * 固定等 2s 在机器忙时不够 —— 实测第二次部署就撞上了"删完还没拷完"的
 * 中间态：换装读到缺失的 chunk，import 失败，整次换装作废，而日志只说一句
 * 失败，真机行为毫无变化。
 *
 * 改成采样到稳定为止：最多等 `maxRounds` 轮，每轮间隔 `QUIET_MS`。
 * 稳定 = 连续两次指纹相同；文件缺失（`missing`）也算一种状态，
 * 所以"删到一半"不会被误判为稳定。
 *
 * @param installDir 安装目录。
 * @param maxRounds 最多采样轮数。
 * @returns 稳定后的指纹。
 */
async function waitForStableFingerprint(installDir: string, maxRounds = 10): Promise<string> {
  let previous = await mtimeFingerprint(installDir);
  for (let round = 0; round < maxRounds; round += 1) {
    await sleep(QUIET_MS);
    const current = await mtimeFingerprint(installDir);
    if (current === previous) return current;
    previous = current;
  }
  // 迟迟不稳：返回当前值让调用方按实际情况处理（不无限等）。
  return previous;
}

/**
 * 启动智能热重载：写内核 → 记基线 → 轮询 → 静默期 → 换装。
 *
 * @param ctx 已 apply 的插件上下文（供换装内核快照/重注册）。
 * @param installDir 安装目录（bundle 产物所在地）。
 * @param logger 日志。
 * @returns 停止函数。
 */
export function startHotReload(
  ctx: Context,
  installDir: string,
  logger?: { info?: (m: string) => void; warn?: (m: string) => void },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let baseline = '';
  let consecutiveFailures = 0;
  /** 换装内核模块（首次换装时动态 import，之后复用）。 */
  interface ReloadCore {
    selfReload: (c: Context, o: object) => Promise<{ ok: boolean; error?: string; fibers?: number; restored?: boolean }>;
    /** 按 entry 换装（四个组件各一条 entry，必须分别换）。 */
    reloadEntries?: (
      c: Context,
      o: { packageUrl: string; entries: ReadonlyArray<{ name: string; file: string }>; logger?: unknown },
    ) => Promise<{ ok: boolean; error?: string; reloaded?: number; restored?: boolean }>;
  }
  /**
   * 取换装内核；**文件不在就先写出来**。
   *
   * ## 为什么必须在换装前重试（2026-10-30 真机事故）
   *
   * `deploy.ps1` 同步产物时会先 `Remove-Item` 插件目录下的**所有文件**，
   * 连 `reload-core.mjs` 一起删掉，然后才拷新产物。于是变化被检测到时，
   * 内核文件已经不在磁盘上了。
   *
   * 旧写法在检测到变化后只 `import` 一次、失败就当整次换装失败 ——
   * 实测后果：chunk 已更新、宿主 PID 未变，但真机 trace note 里探针标记
   * **仍在**，即组件模块根本没换，而日志只说了句失败。
   *
   * 这里改成：每次换装都重新确认内核文件存在（`ensureReloadCore` 幂等，
   * 内容没变不重写），并重新 import —— 内核是随产物重建的，不能缓存它的
   * 身份，否则新内核的 `reloadEntries` 永远用不上。
   *
   * @returns 可用的内核。
   */
  const loadCore = async (): Promise<ReloadCore> => {
    const coreUrl = await ensureReloadCore(installDir);
    // 带 generation 参数 import：内核文件可能刚被重写，裸 URL 会命中旧缓存。
    const fresh = `${coreUrl}?v=${Date.now()}`;
    return (await import(fresh)) as ReloadCore;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const current = await mtimeFingerprint(installDir);
      if (baseline !== '' && current !== baseline) {
        // 等到磁盘稳定（deploy 逐文件删除再写入，固定静默期不够）。
        const settled = await waitForStableFingerprint(installDir);
        baseline = settled; // 无论换装成败都以"当前磁盘"为新基线，避免反复触发

        // 内核随产物重建：每次换装都重新取（见 loadCore 注释）。
        const core = await loadCore();
        logger?.info?.('clis: 检测到代码变化，热重载中…');

        // —— 先换四个组件（各自独立 entry），再换包根 ——
        //
        // 顺序有讲究：包根的 `inject` 依赖三个组件服务。先换包根会让它在
        // 旧组件上重建一次，随后组件换装又触发包根重载 —— 白做一遍。
        const componentResult = await reloadComponents(core, ctx, installDir, logger);
        const rootResult = await core.selfReload(ctx, {
          packageUrl: fileUrl(installDir) + '/',
          entryUrl: fileUrl(pathJoin(installDir, 'index.js')),
          logger,
        });

        const ok = componentResult.ok && rootResult.ok;
        const error = componentResult.error ?? rootResult.error;
        const restored = (componentResult.restored ?? true) && (rootResult.restored ?? true);

        if (ok) {
          consecutiveFailures = 0;
          logger?.info?.(
            `clis: 热重载完成，包根 ${rootResult.fibers ?? '?'} 个 fiber + ${componentResult.reloaded ?? 0} 个组件入口已换装`,
          );
        } else if (restored) {
          // 旧代码已恢复：退避后继续监视（用户改好了会再次触发）
          consecutiveFailures += 1;
          const backoff = Math.min(BACKOFF_MAX_MS, 4_000 * 2 ** Math.min(consecutiveFailures, 5));
          logger?.warn?.(`clis: 热重载失败已回滚（${error ?? 'unknown'}）；${Math.round(backoff / 1000)}s 后恢复监视`);
          await sleep(backoff);
          baseline = await mtimeFingerprint(installDir);
        } else {
          // 旧代码没恢复成：退避并要求人工重启（状态不会更糟）
          consecutiveFailures += 1;
          logger?.warn?.(`clis: 热重载失败且未回滚（${error ?? 'unknown'}）——请重启宿主`);
          return; // 停止监视：代码已死，轮询无意义
        }
      } else if (baseline === '') {
        baseline = current;
      }
    } catch (error) {
      logger?.warn?.(`clis: 热重载监视异常（${String((error as Error)?.message ?? error)}）`);
    }
    if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * 换装四个组件的 loader entry。
 *
 * ## 为什么要单独做（2026-10-30 真机事故）
 *
 * 四个组件在 patch 里是**四条独立 entry**，各自持有 `moduleNamespace` 与
 * fiber。只换包根时，编排器/分类器跑的还是旧模块 —— 实测改了早退判据、
 * 七道闸门全过、磁盘产物确认更新，真机行为却毫无变化。
 *
 * 换装方式：**先清本包模块缓存，再 dispose 旧 fiber、调 entry.init() 重走
 * loader 的完整 import 流程**。
 *
 * 为什么不能用 `entry.update({}, false, true)`：`force` 只让它走到
 * `_patchContext([])`，那一步仅更新 config，**不会重新 import 模块**。
 * 实测（2026-10-30，带 `[HOTRELOAD-PROBE-A]` 标记的组件已落盘、宿主 PID 未变）
 * 真机 trace note 里没有标记 —— 证明组件模块根本没被重新求值。
 *
 * 某条 entry 不存在（用户关了组件）就跳过，不算失败。
 *
 * @param core 换装内核（提供 reloadEntries）。
 * @param ctx 插件上下文。
 * @param installDir 安装目录。
 * @param logger 日志。
 * @returns 换装结果。
 */
async function reloadComponents(
  core: {
    reloadEntries?: (
      c: Context,
      o: { packageUrl: string; entries: ReadonlyArray<{ name: string; file: string }>; logger?: unknown },
    ) => Promise<{ ok: boolean; error?: string; reloaded?: number; restored?: boolean }>;
  },
  ctx: Context,
  installDir: string,
  logger?: { info?: (m: string) => void; warn?: (m: string) => void },
): Promise<{ ok: boolean; error?: string; reloaded?: number; restored?: boolean }> {
  if (core.reloadEntries === undefined) {
    // 旧内核（未随本次部署更新）：只换包根，并明确告知缺口，不假装成功。
    logger?.warn?.('clis: 换装内核缺少 reloadEntries —— 本次只换包根，四个组件仍是旧代码');
    return { ok: true, reloaded: 0, restored: true };
  }
  const entries = Object.entries(ENTRY_FILES)
    .filter(([name]) => name !== 'dsh-clis')
    .map(([name, file]) => ({ name, file }));
  return core.reloadEntries(ctx, {
    packageUrl: fileUrl(installDir) + '/',
    entries,
    logger,
  });
}

/** 可中断的睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
