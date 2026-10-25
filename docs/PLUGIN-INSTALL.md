# CLIS 常驻插件 · 安装与使用

## 现状

已作为本地常驻插件安装到 `web` profile：

| 项 | 值 |
| --- | --- |
| 安装位置 | `C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-clis` |
| profile 链接 | `C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-clis`（junction） |
| bundle | `index.js`（145 KB，esbuild 单文件） |
| 插件名 | `clis` |

> **需要重启宿主才生效**：profile 的 `package.json` 与 bundles 列表已改，但宿主进程仍持有旧配置。

## 一、构建

```powershell
$env:Path = "D:\nvm\v22.23.3;" + $env:Path
cd D:\个人开发\CLIS

# 1. 类型检查与测试（闸门）
pnpm exec tsc -p tsconfig.json     # 期望 exit 0
pnpm exec vitest run               # 期望 33 文件 449 例全绿

# 2. 打包
pnpm exec node scripts/bundle.mjs  # 产出 bundle/clis.js

# 3. 同步到插件目录
Copy-Item bundle\clis.js C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-clis\index.js -Force

# 4. 冒烟验证（用宿主那份 cordis 建 Context 装载）
pnpm exec node scripts/smoke-installed.mjs   # 期望 SMOKE PASS
```

## 二、为什么要打包、为什么 cordis 要内联

**必须打包**：`tsc` 产出的相对导入没有扩展名，Node ESM 解析不了；且 `tsc` 的 `paths` 映射只在编译期生效，跨包 `import '@clis/clis-contracts'` 会被抹掉。

**cordis 必须内联**：profile 安装的 bundle 以 junction 指向 `default-workspace`，其 realpath 下没有宿主的 `node_modules/@deepseek-ai/*`。
实测裸导入会 `ERR_MODULE_NOT_FOUND`。

内联后是否会造成"两份 Service 注册表、`inject` 永远等不到"？**实测不会**：
用宿主那份 cordis 建 Context 装载本插件，四个服务全部可见、闭环跑通、卸载干净。
`scripts/smoke-installed.mjs` 就是钉住这一点的回归测试。

## 三、手动开关（用户）

**Settings → Plugins**（或 Plugin Manager）里找到「CLIS 因果分层系统」，直接启用/停用。

- 停用后四个服务随之移除，不影响其它插件
- 图标与中英文标题来自 `locale/*.json` 与 `icon.svg`

## 四、agent 热插拔

本包声明了 `dsh.bundle.patch`，所以 agent 可用 `plugin_manager`：

```
plugin_manager(action: "list_plugins")
plugin_manager(action: "set_plugin", target: "clis", enabled: false)
plugin_manager(action: "set_plugin", target: "clis", enabled: true)
```

开关即时生效（服务随 fiber 装卸），无需重启宿主。
**注意**：替换 `index.js`（即升级 bundle）后需要重启宿主才能加载新的 JS 模块代。

## 五、注册的服务

| 服务名 | 职责 |
| --- | --- |
| `clis.causalClassifier` | 因果类型判断（置信度上限 0.9，<0.7 进探索模式） |
| `clis.causalStrategy` | 策略匹配、候选路径排序、执行（不判断类型） |
| `clis.causalFeedback` | 反馈信号检测、类型误判识别、回退建议（不执行回退） |
| `clis.causalOrchestrator` | 编排闭环、回退上限 3 次、震荡锁定、完整 trace |

## 六、已知限制

1. **无 agent tool 入口**：目前四个插件只注册服务，agent 无法从对话里直接触发 CLIS。
   要做成"可对话使用"，还需补一个 `defineTool` 包一层（例如 `clis_run(description, answers)`）。
2. **四问作答需人工给定**：`CausalProblem.answers` 是四个三态字段，暂无"从自然语言自动抽取"的环节。
3. **ActionExecutor 只有接口**：执行真实动作时由调用方提供；当前无默认实现。
4. **profile 写锁**：安装期间遇到宿主持有的 `package.json.lock`，`plugin_manager install_bundle` 超时，
   最终采用手工登记（改 `package.json` + bundles 列表 + junction）。

## 七、卸载

```powershell
# 1. 从 profile package.json 移除 dsh-clis 依赖与 bundles 列表项
# 2. 删除 junction
Remove-Item C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-clis -Force
# 3. 重启宿主
```

备份：`C:\Users\lyq\.dsh\profiles\web\package.json.bak-clis`
