import type { Context } from '@deepseek-ai/cordis';
import type { HealthFinding, HealthProbe, HealthReport } from '@clis/clis-contracts';
import { deriveStatus } from '@clis/clis-contracts';

import { historyFilePath, readHealthState } from './history';

/**
 * CLIS 自身的健康探针 —— 让它能被其他插件自动检查。
 *
 * 检查什么（只查"会让能力悄悄失效"的事，不查代码风格）：
 * 1. 四个因果服务是否就位（缺一个闭环就断了）；
 * 2. 历史文件是否可写（写不了则误判检测永远不触发，且不会报错）；
 * 3. 历史里是否有长期只失败不成功的假设（说明判据可能有问题）。
 *
 * 为什么不查"工具有没有注册"：那由宿主自己保证，重复检查是噪音。
 */
export class ClisHealthProbe implements HealthProbe {
  /**
   * @param ctx 插件上下文（用于取三个因果服务）。
   * @param pluginVersion 当前运行的插件版本，便于诊断时确认跑的是哪一版。
   */
  constructor(
    private readonly ctx: Context,
    private readonly pluginVersion: string,
  ) {}

  /**
   * 执行自检。**只读**：不写任何业务数据。
   *
   * @returns 结构化结论。
   */
  async probe(): Promise<HealthReport> {
    const findings: HealthFinding[] = [];

    // —— 1. 四个服务是否就位 ——
    const services: Array<[string, string]> = [
      ['clis.causalClassifier', '因果分类器'],
      ['clis.causalStrategy', '策略匹配器'],
      ['clis.causalFeedback', '反馈检测器'],
      ['clis.causalOrchestrator', '闭环编排器'],
    ];

    for (const [serviceName, label] of services) {
      // 必须用 ctx.get() 而不是 ctx[serviceName]：
      // Cordis 的 Context 代理对**未 inject 的服务键**直接抛错
      // （实测 `cannot get property "clis.causalFeedback" without inject`）。
      // 探针的职责是"检查它是否就位"，不是"使用它" —— 用 get() 才能
      // 安全地探测缺失情况，而不会自己先崩掉。
      const present = this.safeGet(serviceName) !== undefined;
      if (!present) {
        findings.push({
          code: 'clis.service-missing',
          severity: 'error',
          message: `${label}（${serviceName}）不可用：依赖它的工具会全部停用`,
          location: `dsh-clis/${serviceName}`,
          hint: '多半是对应组件被关闭或装载失败；在 Plugin Manager 里确认它的 fiberPhase 是否为 active',
        });
      }
    }

    // —— 2. 历史存储是否可读 ——
    try {
      const state = await readHealthState();
      if (state === undefined) {
        findings.push({
          code: 'clis.history-absent',
          severity: 'info',
          message: '尚未产生使用历史（还没有人真正用过 clis_run，或从未回填 last_outcome）',
          location: historyFilePath(),
          hint: '这不影响判断能力，但误判检测需要真实结果才能触发',
        });
      } else {
        // —— 3. 反复失败却从未成功的假设 ——
        for (const [key, record] of Object.entries(state.records)) {
          const failures = record.entries.filter(
            (entry) =>
              entry.baseline !== true &&
              (entry.signal_type === 'ineffective' || entry.signal_type === 'type_misjudged'),
          ).length;
          const successes = record.entries.filter((entry) => entry.signal_type === 'effective').length;

          if (failures >= 3 && successes === 0) {
            findings.push({
              code: 'clis.assumption-stuck',
              severity: 'warn',
              message: `问题「${record.description.slice(0, 40)}」在同一因果假设下已失败 ${failures} 次、从未成功`,
              location: key,
              hint: '这不是执行问题而是判据问题：该假设很可能从一开始就错了，换一种因果类型重新提问比继续调策略有效',
            });
          }
        }
      }
    } catch (error) {
      findings.push({
        code: 'clis.history-unreadable',
        severity: 'error',
        message: `历史文件读不出来：${String((error as Error)?.message ?? error).slice(0, 120)}`,
        location: historyFilePath(),
        hint: '读不出历史意味着误判检测失效，且不会有任何报错提示 —— 检查文件权限或是否被其他进程占用',
      });
    }

    return {
      plugin: 'dsh-clis',
      status: deriveStatus(findings),
      findings,
    };
  }

  /**
   * 安全读取一个服务，缺失时返回 undefined 而不抛错。
   *
   * Cordis 的 Context 代理对未 inject 的键会抛
   * `cannot get property "X" without inject`，探针不能因此崩掉 ——
   * 它在做的正是"检查这些服务在不在"。
   *
   * @param serviceName 服务名。
   * @returns 服务实例；不可用时 undefined。
   */
  private safeGet(serviceName: string): unknown {
    const getter = (this.ctx as unknown as { get?: (name: string) => unknown }).get;
    if (typeof getter === 'function') {
      try {
        return getter.call(this.ctx, serviceName);
      } catch {
        return undefined;
      }
    }
    // 兜底：没有 ctx.get 时退回属性访问并吞掉代理抛错
    try {
      return (this.ctx as unknown as Record<string, unknown>)[serviceName];
    } catch {
      return undefined;
    }
  }

  /** 便于诊断时确认跑的是哪一版。 */
  version(): string {
    return this.pluginVersion;
  }
}
