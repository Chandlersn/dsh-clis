# 发布说明

面向维护者。**当前仓库处于"可开源但未发布"状态** —— 下文列出发布前必须改的东西。

## 现状：刻意不可发布

`packaging/package.json` 里 `"private": true`。这是**安全默认**：npm 不会误发，
`pnpm publish` 也会拒绝。发布前需显式改掉，见下。

## 发布前清单

### 1. 定 npm 包名

当前 `"name": "dsh-clis"`是**无作用域名**，npm 上很可能已被占用。
发布前改成作用域形式：

```json
"name": "@<你的 npm 用户名>/dsh-clis"
```

改完后，`cordis.patch.yml` 里 5 行的 `name:` 也要同步改
（`dsh-clis/classifier` → `@<user>/dsh-clis/classifier` 等），
否则装载时解析不到子路径。

### 2. 摘掉 private

```json
"private": false
```

### 3. 校验产物

```bash
node scripts/bundle.mjs
node scripts/package.mjs
```

`package.mjs` 会自检 15 项必需文件（5 个 JS 入口、patch、package.json、icon、
README、LICENSE、四组件 locale）。缺任何一项它就退出非零 —— 不要绕过。

再用 `npm pack --dry-run`（在 `dist-package/` 里）核对实际打包内容。

### 4. 冒烟（真机装载）

```powershell
.\scripts\deploy.ps1            # 七道闸门 + 同步 + 重启
```

重启后用 `clis_probe` 确认：
- `supervision.active_plugins` 等字段正常返回
- 四个组件在 Plugin Manager 里都是 `active`
- 四个工具（`clis_run` / `clis_classify` / `clis_plan` / `clis_probe`）都能调用

`scripts/smoke-components.mjs`（组件装载）与 `scripts/smoke-tools.mjs`
（工具返回值经宿主 `isJsonValue` 校验）是必过的两道。

## 已经踩过的发布相关坑

按"会让人装不上"的严重度排：

| 坑 | 症状 | 原因 |
| --- | --- | --- |
| 缺 `package.json` 的 `exports["."]` | Loader **静默跳过整个包**，patch 行全 `absent`，日志无报错 | Loader 按 `exports` 解析包根 |
| `@deepseek-ai/cordis` 被内联进 bundle | 服务注册进 ctx 但宿主不认，依赖方 `inject` 永不满足，**且不报错** | 内联产生第二个 `Service` 类，`instanceof 宿主Service === false`。必须走 `cordis-shim.ts` |
| 组件入口在模块期解析宿主包 | 装载失败或拿到错误的宿主 | 必须惰性解析（`getDefineTool()` 之类） |
| 工具返回值含 `undefined` | 宿主报 `value is not lossless JSON`，工具不可用 | 宿主用 `isJsonValue` 校验；用 `toToolJson` 递归剔除 |
| 组件被重复注册 | 服务名冲突或双份实例 | 包根入口只注册工具与提示段，**不装载四个组件**（由 patch 四行各自装载） |
| `cpSync` 复制**目录** | 进程直接崩，退出码 `-1073740791`（`0xC0000409`） | 本机 fs 中间层拦截递归目录复制。`scripts/package.mjs` 因此改成逐文件复制；`bundle.mjs` 同理回避 `rmSync` |

## 开发环境注意（Windows 本机）

1. **判原生命令成败只认 `$LASTEXITCODE`，且别让它过管道。**
   `命令 | Select-Object` 之后退出码不可信；命令的 stderr（git 的 CRLF 警告、进度）
   会被 PowerShell 当成 `NativeCommandError` 报出，**使成功的命令显示成失败**。
   写 `命令 2> $errFile` 再读 `$LASTEXITCODE`，stderr 只在真失败时才看。
   判据永远是外部结果（提交在不在 `git log` 里、工作区干不干净），不是退出码本身。

2. **`pnpm` 可能不在 PATH 里**（宿主重启后）。`deploy.ps1` 已能自行查找
   （PATH → 常见 nvm 位置），手动调用时用绝对路径或设 `$env:DSH_NODE_DIR`。

3. **vitest 报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`**：宿主自带 safe-delete 中间层
   拦截对 `node_modules/.vitest-cache` 的批量清理（条目数 > 50 即要求确认）。
   删掉该缓存目录后重跑；**不要**为此关闭删除保护。

4. **PowerShell 脚本必须存 UTF-8 BOM**，否则中文被按 GBK 读、解析报
   `表达式或语句中包含意外的标记`。`deploy.ps1` 改完记得确认 BOM 还在。

## 版本约定

- `packaging/package.json` 的 `version` 是**发布版本**，改它需同步 `packages/clis-plugin/src/index.ts` 的 `PLUGIN_VERSION`（探针会带上它，用于确认跑的是哪一版）。
- 就地升级已安装插件需**重启宿主**：link 安装只改了磁盘，进程缓存旧模块代。