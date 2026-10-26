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

/** 安装目录里被监视的文件集合（bundle 产物 + 本内核）。 */
function watchedFiles(installDir: string): string[] {
  return [
    'index.js',
    'clis-classifier.js',
    'clis-strategy.js',
    'clis-feedback.js',
    'clis-orchestrator.js',
    'reload-core.mjs',
  ].map((name) => pathJoin(installDir, name));
}

/** 读取一组文件的 mtime 指纹；任一缺失即视为变化（部署中途）。 */
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
  }
  let core: ReloadCore | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const current = await mtimeFingerprint(installDir);
      if (baseline !== '' && current !== baseline) {
        // 静默期：deploy 逐文件写 / 编辑器原子替换都有时间窗，等它写完
        await sleep(QUIET_MS);
        const settled = await mtimeFingerprint(installDir);
        baseline = settled; // 无论换装成败都以"当前磁盘"为新基线，避免反复触发

        if (core === undefined) {
          const coreUrl = await ensureReloadCore(installDir);
          core = (await import(coreUrl)) as ReloadCore;
        }
        logger?.info?.('clis: 检测到代码变化，热重载中…');
        const result = await core.selfReload(ctx, {
          packageUrl: fileUrl(installDir) + '/',
          entryUrl: fileUrl(pathJoin(installDir, 'index.js')),
          logger,
        });

        if (result.ok) {
          consecutiveFailures = 0;
          logger?.info?.(`clis: 热重载完成，${result.fibers ?? '?'} 个 fiber 已换装`);
        } else if (result.restored) {
          // 旧代码已恢复：退避后继续监视（用户改好了会再次触发）
          consecutiveFailures += 1;
          const backoff = Math.min(BACKOFF_MAX_MS, 4_000 * 2 ** Math.min(consecutiveFailures, 5));
          logger?.warn?.(`clis: 热重载失败已回滚（${result.error ?? 'unknown'}）；${Math.round(backoff / 1000)}s 后恢复监视`);
          await sleep(backoff);
          baseline = await mtimeFingerprint(installDir);
        } else {
          // 旧代码没恢复成：退避并要求人工重启（状态不会更糟）
          consecutiveFailures += 1;
          logger?.warn?.(`clis: 热重载失败且未回滚（${result.error ?? 'unknown'}）——请重启宿主`);
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

/** 可中断的睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
