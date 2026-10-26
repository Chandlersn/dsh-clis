/**
 * 插件健康探针（HealthProbe）—— 插件之间互相发现异常的**共同语言**。
 *
 * 为什么需要它（2026-10-26 用户目标：插件互查互治）：
 * 宿主里各插件各写各的检查：memory-manager 有 memory_check，
 * CLIS 有自己的一套，别的插件可能什么都没有。没有统一形状，
 * 跨插件自动监督就无从谈起 —— 谁也不知道该问谁、问出什么。
 *
 * 这份契约只定义"怎么说"，不定义"说什么"：
 * - 探针自己决定检查什么（记忆链接、因果闭环、依赖解析…）
 * - 但**怎么说**必须一致，否则收集方无法汇总结论
 *
 * 刻意不做的：
 * - 不带 `suggestedFix`：修复是写操作，跨插件自动改别人的数据风险太高。
 *   探针只报告事实与提示，动手由人决定。
 * - 不带时间戳：时间由收集方在汇总时打，避免各插件时钟口径不一。
 */

/** 发现项的严重程度。 */
export const HEALTH_SEVERITIES = ['info', 'warn', 'error'] as const;

export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];

/** 单个发现项。 */
export interface HealthFinding {
  /**
   * 稳定的规则代号（如 `R14`、`link-dangling`）。
   *
   * **必须稳定**：收集方靠它去重、靠它判断"是否是新问题"。
   * 用它而不是 message —— message 常含具体文件名，每次都变。
   */
  readonly code: string;
  readonly severity: HealthSeverity;
  /** 一句话说清问题（≤200 字）。 */
  readonly message: string;
  /**
   * 指向具体位置，便于人去看（如文件路径、行号、插件 id）。
   * 可省略：有些问题没有单一位置。
   */
  readonly location?: string;
  /**
   * 一句话提示"该往哪个方向看"，**不是**修复指令。
   *
   * 例："同类规则连续多块都超标，考虑在写入时加校验，而不是事后修"
   * —— 这种提示能帮人看到结构，而"把文件截断到 900 字"属于治，不在此列。
   */
  readonly hint?: string;
}

/** 探针自检结论。 */
export interface HealthReport {
  /** 探针所属插件名（与 package.json 的 name 一致）。 */
  readonly plugin: string;
  /**
   * 整体状态：
   * - `ok`：无 warn/error
   * - `degraded`：有 warn 但无 error
   * - `failing`：有 error
   */
  readonly status: 'ok' | 'degraded' | 'failing';
  readonly findings: readonly HealthFinding[];
}

/**
 * 健康探针接口：插件实现它，就能被其他插件自动发现与检查。
 *
 * 实现约定：
 * - **只读**：probe 绝不允许修改任何数据（这是跨插件调用的前提）
 * - **不抛错**：自身检查失败也应转成一条 `severity: 'error'` 的 finding，
 *   而不是抛出 —— 抛错会让整个汇总塌掉，反而是最需要被发现的插件导致看不见。
 * - **快速**：可能被定时调用，不做重活。
 */
export interface HealthProbe {
  /**
   * 执行一次自检。
   *
   * @returns 结构化结论。
   */
  probe(): Promise<HealthReport>;
}

/**
 * 由 findings 推导整体状态。
 *
 * 唯一实现：避免每个探针各写一遍判断逻辑导致口径不一。
 *
 * @param findings 发现项列表。
 * @returns ok / degraded / failing。
 */
export function deriveStatus(findings: readonly HealthFinding[]): HealthReport['status'] {
  if (findings.some((item) => item.severity === 'error')) return 'failing';
  if (findings.some((item) => item.severity === 'warn')) return 'degraded';
  return 'ok';
}

/** 健康探针在 Cordis 上下文中的服务名（多探针按此 key 注册/查找）。 */
export const HEALTH_PROBE_SERVICE = 'clis.healthProbe';
