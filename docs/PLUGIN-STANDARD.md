# DSH 插件封装标准（含健康探针接口）

> 本文件是 harness 官方标准的**项目侧补充**。官方标准见
> `@deepseek-ai/dsh-package-manifest`（`package.json.dsh` 字段类型）与
> `cordis-plugin-development` 技能（`references/host-plugin.md`）。
> 本文件只做一件事：**把「自愿健康探针」接口并入那条标准的具名导出族**，
> 使新插件不再遗漏。

## 为什么需要这份补充

harness 的 Host 插件标准规定 `index.js` 导出下列形式之一：

```js
export function apply(ctx, config) {}
export const inject = ['tools']    // 可选具名导出
export const Config = { ... }      // 可选具名导出
```

`inject` 与 `Config` 都是**同族的可选具名导出**：宿主在装载时读取它们。
健康探针接口属于同一族，因此标准应当并列声明——否则每个新插件都会
遗漏它，跨插件监督体系就永远覆盖不全。

## 标准：三个可选具名导出

```js
// index.js
export const inject = ['tools']              // 声明依赖（官方标准）
export const Config = { /* schemastery */ } // 声明配置（官方标准）
export const healthProbe = {                 // 健康探针（本标准新增）
  async probe() {
    return {
      plugin: 'my-plugin',          // 必填：与包名一致
      status: 'ok',                 // 必填：ok | degraded | failing
      findings: [],                 // 必填：发现项数组，无问题时空数组
    }
  },
}
export function apply(ctx, config) { /* ... */ }
```

### 为什么是 `healthProbe` 而不是别的名字

- 它是**可选**的：不导出不报错，插件正常工作，只是进入"仅结构监督"层级。
- 它与 `inject`/`Config` 同族：都是模块根具名导出，宿主/监督者读取。
- **不需要注册、不需要发事件、不需要改 patch**：导出即被发现。

### finding 的形状

```ts
interface HealthFinding {
  code: string       // 必填：稳定的规则代号（R14 / link-dangling / …）
  severity: 'info' | 'warn' | 'error'   // 必填
  message: string    // 必填：一句话说清问题
  location?: string  // 可选：文件路径 / 服务名 / 行号
  hint?: string      // 可选：方向提示（不是修复指令）
}
```

**`code` 必须稳定**：监督侧靠它去重、靠它判断"是否是新问题"。
不要用 message 当判据 —— message 常含具体文件名，每次都变。

### 两条硬约束

1. **只读**：`probe()` 绝不修改任何数据。它会被其他插件/agent 反复调用，
   有副作用会让"检查"变成"破坏"。
2. **不抛错**：自身检查失败也要转成 `severity: 'error'` 的 finding，
   不要 `throw` —— 抛错会让自己从监督视野里消失，而坏掉的探针恰恰
   是最需要被发现的。

## 协议规范提醒：探针要不要取服务

探针常需要检查"某个服务在不在"。**必须用 `ctx.get(name)`**，不要用
`ctx[name]`：

```js
// 错的：Cordis 的 Context 代理对未 inject 的键直接抛错
if (!ctx['some.service']) { ... }   // → cannot get property "x" without inject

// 对的：缺失时返回 undefined，正是"检查存在性"要的行为
if (ctx.get('some.service') === undefined) { /* 报告缺失 */ }
```

## 三层监督：不导出探针也不会被遗漏

监督者（CLIS）对**所有非内建插件**都有两层覆盖，插件是否导出探针只
决定监督的**深度**，不决定**有无**：

| 层 | 来源 | 覆盖 | 能发现 |
|---|---|---|---|
| **自动层** | loader 元数据（`fiber.state` / `options.inject`） | **100%** 非内建插件 | 卡在装载、意外未激活、依赖未满足 |
| **协作层** | 本插件导出的 `healthProbe` | 导出者 | 自身领域内的具体问题 |
| **显式注册** | `ctx.emit('clis/register-probe', …)` | 需要动态上下文者 | 同上，但可用于探针依赖运行时配置的场景 |

**自动层不需要插件做任何事**，所以"以后新增的插件不会被遗漏"这件事
由架构保证，不依赖作者是否记得导出。

## 怎么验证自己的插件合规

```bash
# 1. 语法与导出
node --check index.js
node -e "import('./index.js').then(m => console.log(Object.keys(m)))"

# 2. 探针自检（若有 healthProbe 导出）
node -e "
import('./index.js').then(async (m) => {
  if (!m.healthProbe) return console.log('无 healthProbe 导出（合法，仅结构监督）');
  const r = await m.healthProbe.probe();
  console.log(JSON.stringify(r, null, 2));
})
"
```

## 检查清单（新插件封装时逐条过）

- [ ] `package.json` 有 `exports["."]`（缺了 Loader 会**静默跳过整个包**）
- [ ] `package.json` 有 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- [ ] `locale/<lang>.json` 有 `meta.title` / `meta.description`
- [ ] `icon.svg` 已导出（`exports["./icon"]`）且写进 `files`
- [ ] `index.js` 导出 `apply`（或 Service 类），**不混用**
- [ ] 资源注册用 `ctx.effect` / `ctx.on` 并返回清理函数
- [ ] **导出了 `healthProbe`**（推荐；缺了会被自动层兜住，但监督变浅）
- [ ] 若导出 `healthProbe`：`probe()` 只读、不抛错、`code` 稳定

## 与官方标准的关系

本方补充**不修改**官方标准，只在其具名导出族中增加一个可选成员。
官方标准若未来纳入健康探针接口，以官方为准，本文件相应删除该节。