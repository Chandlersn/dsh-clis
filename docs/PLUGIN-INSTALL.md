# CLIS 常驻插件 · 安装与使用

## 现状

已作为本地常驻插件安装到 `web` profile，包含**四个可独立开关的组件**。

| 项 | 值 |
| --- | --- |
| 安装位置 | `C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-clis` |
| profile 链接 | `C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-clis`（junction） |
| 版本 | 0.2.0（四组件） |
| bundles 列表项 | `dsh-clis` |

## 一、四个组件

| 组件 | 入口 | 服务名 |
| --- | --- | --- |
| 因果分类器 | `clis-classifier.js` | `clis.causalClassifier` |
| 策略匹配器 | `clis-strategy.js` | `clis.causalStrategy` |
| 反馈检测器 | `clis-feedback.js` | `clis.causalFeedback` |
| 闭环编排器 | `clis-orchestrator.js` | `clis.causalOrchestrator` |

patch 里四行各自独立，面板上显示为四个可分别开关的组件：

```yaml
- insert:
    - id: clis-classifier
      name: 'dsh-clis/classifier'
    - id: clis-strategy
      name: 'dsh-clis/strategy'
    - id: clis-feedback
      name: 'dsh-clis/feedback'
    - id: clis-orchestrator
      name: 'dsh-clis/orchestrator'
```

### 独立开关的连带关系

`inject` 决定依赖：停用 `clis-classifier` 会连带停用 `strategy` 与 `orchestrator`（它们 inject 分类器），`feedback` 独立不受影响。

## 二、构建

```powershell
$env:Path = "D:\nvm\v22.23.3;" + $env:Path
cd D:\个人开发\CLIS

# 1. 闸门
pnpm exec tsc -p tsconfig.json     # 期望 exit 0
pnpm exec vitest run               # 期望 33 文件 449 例全绿

# 2. 打包四入口（代码分割，共享 cordis chunk）
pnpm exec node scripts/bundle.mjs

# 3. 同步到插件目录
$dir = 'C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-clis'
Copy-Item bundle\*.js $dir -Force

# 4. 冒烟（28 项：加载/命名/依赖/独立开关/闭环/卸载）
pnpm exec node scripts/smoke-components.mjs   # 期望 SMOKE PASS
```

## 三、为什么这样打包

**必须打包**：`tsc` 产出的相对导入没有扩展名，Node ESM 解析不了；`tsc` 的 `paths` 映射只在编译期生效，跨包 import 会被抹掉。

**cordis 内联而非外置**：profile 的 bundle 以 junction 指向 `default-workspace`，realpath 下没有宿主的 `node_modules/@deepseek-ai/*`，裸导入必然 `ERR_MODULE_NOT_FOUND`。

**用代码分割**：四个入口若各打一份 cordis 会得到四份副本（体积翻四倍）。`splitting: true` 让它们共享 `chunk-*.js`。

**内联的 Service 为何仍能与宿主协作**：服务注册走 `ctx.reflect.provide`，用的是宿主传进来的 `ctx`，不依赖类身份比对。实测四服务在宿主 Context 下全部可见、卸载干净——`scripts/smoke-components.mjs` 就是钉住这一点的回归测试。

## 四、手动开关（用户）

**Settings → Plugins**（或 Plugin Manager）里找到四个组件，各自启用/停用。图标与中英文标题来自各组件的 `locale/`。

## 五、agent 热插拔

```js
plugin_manager({ action: 'list_plugins' })
plugin_manager({ action: 'set_plugin', target: 'clis-classifier', enabled: false })
```

开关即时生效（服务随 fiber 装卸），无需重启宿主。
**替换 `.js`（升级）后需要重启宿主**才能加载新的模块代。

## 六、已知限制

1. **无 agent tool 入口**：四个组件只注册服务，agent 无法从对话直接触发。
   工具壳 `packages/clis-plugin/src/tools.ts` 已写好（`clis_run` / `clis_classify` / `clis_plan`），
   但尚未接入四组件入口——它需要 `defineTool`（来自 `@deepseek-ai/dsh-tools`），
   而该包在 link 布局下如何解析尚待解决。
2. **四问作答需人工给定**：`CausalProblem.answers` 是四个三态字段，暂无自然语言→四问的抽取环节。
3. **ActionExecutor 只有接口**：执行真实动作时由调用方提供；当前无默认实现。

## 七、卸载

```powershell
# 1. 从 profile package.json 移除 dsh-clis 依赖与 bundles 列表项
# 2. 删除 junction
Remove-Item C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-clis -Force
# 3. 重启宿主
```

备份：`C:\Users\lyq\.dsh\profiles\web\package.json.bak-clis`
