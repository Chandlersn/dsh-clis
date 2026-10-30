/**
 * 失败**性质**分类 —— 决定这次失败值不值得用"因果结构"去介入。
 *
 * ## 为什么需要它（2026-10-30 真实会话转录复算）
 *
 * 介入器原来的判据只有"同一工具、同一签名、2 分钟内重复 2 次"。把
 * 71 个会话 / 1186 条真实失败回放进去，触发 41 次，拆开看：
 *
 * | 类别 | 次数 | 举例 |
 * | --- | --- | --- |
 * | INFRA 设施型 | 15 | `Auto review of tool "pwsh" failed`、`web fetch failed` |
 * | SEM 语义型 | 17 | 测试失败、构建失败、脚本逻辑错 |
 * | MECH 机械型 | 9 | `file has not been read`、`old_string was not found` |
 *
 * 而提示文案讲的是"回路会越修越弹、对偶会一边修一边被拉回去"——
 * 对 `old_string was not found` 这类机械错误既不对题也不可执行；
 * 对 `web fetch failed` 更是纯噪音（重试网络比判因果有用）。
 *
 * **真正属于因果结构判断该管的只有 SEM 类**：它占全部失败的 1.4%。
 * 换句话说，原来的闸门有 59% 的火力打在无关的地方。
 *
 * ## 三类各自该被怎么对待
 *
 * - **MECH**：换个参数就能过（先读文件、修锚点、补必填项）。
 *   正确答案是"照做"，不是"判因果"。
 * - **INFRA**：宿主/网络/审查器故障，与任务本身无关。
 *   正确答案是"重试或换路"，不是"判因果"。
 * - **SEM**：方法、假设、判据本身可能有问题 —— 这才是 CLIS 的战场。
 *
 * 分类**宁可漏判**：拿不准的一律归 SEM（宁可多说一句，也不吞掉真正该管的）。
 * 漏判的代价是多一次提示；误判的代价是该介入时沉默。
 */

/** 失败性质。 */
export const FAILURE_KINDS = ['MECH', 'INFRA', 'SEM'] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * 机械型：参数、锚点、前置条件没满足 —— 照做就能过。
 *
 * 判据都是宿主自己的错误文案（不是我们发明的规则），
 * 因为它们是"这一类失败"最稳定的指纹。
 */
const MECH_PATTERNS: readonly RegExp[] = [
  // 编辑锚点
  /old_string/i,
  /FS_EDIT_NOT_FOUND/i,
  /String to replace/i,
  // 前置条件：先读再改
  /file has not been read/i,
  /file changed (?:since|on disk)/i,
  // 参数形状
  /invalid arguments/i,
  /missing required property/i,
  /unknown tool/i,
  /is only valid together with/i,
  // 路径与转义（Windows 上最常见的一类）
  /Cannot find path/i,
  /ENOENT/i,
  /no such file/i,
  /does not exist/i,
  /ParserError/i,
  /Unexpected token/i,
  /is not recognized as a name of a cmdlet/i,
  /Variable reference is not valid/i,
  /missing terminator/i,
];

/**
 * 设施型：宿主、网络、审查器、跨进程状态的问题。
 *
 * 与任务本身无关，重试或换路才有意义；判因果在这里是空转。
 */
const INFRA_PATTERNS: readonly RegExp[] = [
  // 宿主的 auto-review 前置审查（它自己挂了，工具体根本没执行）
  /Auto review of tool/i,
  // 工具输出形状不合宿主校验（是插件缺陷，不是任务问题）
  /returned invalid output/i,
  /is not lossless JSON/i,
  /must be one of \[/i,
  // 服务注入缺失（同样是插件缺陷）
  /without inject/i,
  /storageDomain/i,
  // 超时与网络
  /timed out after/i,
  /fetch failed/i,
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up/i,
  // 宿主中断/持久化异常
  /interrupted after it was recorded/i,
  /no result was durably recorded/i,
  /hook never ran/i,
  // 平台权限
  /SetNamedSecurityInfoW/i,
  /EPERM|EACCES|access denied/i,
];

/**
 * 判定一次失败的性质。
 *
 * 顺序：先 INFRA 后 MECH —— 因为"插件返回非法输出"里可能夹带
 * `does not exist` 之类的字样，但它本质是设施问题，不该被当成机械错误。
 *
 * @param tool 工具名（参与判据：同一段文案在不同工具下含义不同）。
 * @param message 失败消息（可为空 —— 空串归 SEM，宁可多说）。
 * @returns 失败性质；拿不准时返回 `SEM`。
 */
export function classifyFailureKind(tool: string, message: string): FailureKind {
  const haystack = `${tool}\n${message}`;
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(haystack)) return 'INFRA';
  }
  for (const pattern of MECH_PATTERNS) {
    if (pattern.test(haystack)) return 'MECH';
  }
  return 'SEM';
}

/**
 * 只有这一类值得用因果结构介入。
 *
 * 单列成函数而不是散落比较：将来若要放行 INFRA（例如"同一个网络错误
 * 反复出现十次，可能真是链路问题"），只改这一处。
 *
 * @param kind 失败性质。
 * @returns 是否值得介入。
 */
export function worthCausalIntervention(kind: FailureKind): boolean {
  return kind === 'SEM';
}
