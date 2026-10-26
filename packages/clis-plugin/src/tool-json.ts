/**
 * 工具返回值的**净化出口** —— 剥离所有 `undefined` 属性。
 *
 * 为什么必须有它（2026-10-26 真实审查抓到的致命缺陷）：
 * 宿主工具输出管线用 `isJsonValue` 做无损 JSON 校验，规则是
 * **任一属性值为 `undefined` 即整体判非法**，报
 * `ToolOutputError: value is not lossless JSON`，工具直接不可用。
 * 而契约里的可选字段（`exploration_reason`、`suggested_rollback`、
 * `sub_modules`、`candidate_hypotheses`）在服务返回时经常是
 * `字段名: undefined`。不净化就整包被拒，且宿主只报一句笼统的错。
 *
 * 本模块刻意**不依赖任何宿主包**：纯数据变换，可在单元测试里直接导入，
 * 不必造宿主环境。
 */

/**
 * 递归剥离 `undefined` 属性，产出可被宿主接受的纯 JSON 值。
 *
 * 行为约定：
 * - 对象：值为 `undefined` 的键**删除**（不是置 null，null 是合法值）；
 * - 数组：`undefined` 元素被**移除**（数组因此可能变短；null 会保留占位）；
 * - 合法值（`null`、`false`、`0`、`''`、`[]`、`{}`、`NaN`）原样保留；
 * - `Date` 视为叶子不动（是否合法由宿主另判）；
 * - 不修改入参（纯函数）。
 *
 * @param value 待净化的值。
 * @returns 净化后的新值。
 */
export function toToolJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => toToolJson(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      result[key] = toToolJson(item);
    }
    return result as unknown as T;
  }
  return value;
}
