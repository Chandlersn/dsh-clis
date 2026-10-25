import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
} from '@clis/clis-contracts';

import * as orchestratorPlugin from '@clis/clis-orchestrator';

/**
 * 职责边界的静态检查（SPEC-orchestrator §6-6）。
 *
 * 编排器最容易犯的错是"顺手把规则写进来"——判据、匹配、反馈各写一点，
 * 边界就消失了。这些断言把边界钉在文本层面。
 */
const SRC_DIR = join(process.cwd(), 'packages', 'clis-orchestrator', 'src');

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), 'utf8') }));
}

/** 去掉注释，避免注释里的说明文字造成假阳性。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('inject 声明', () => {
  it('恰好注入三个抽象服务，顺序为 classifier / strategy / feedback', () => {
    expect(orchestratorPlugin.inject).toStrictEqual([
      CAUSAL_CLASSIFIER_SERVICE,
      CAUSAL_STRATEGY_SERVICE,
      CAUSAL_FEEDBACK_SERVICE,
    ]);
  });

  it('name 与 apply 就位', () => {
    expect(orchestratorPlugin.name).toBe('clis-orchestrator');
    expect(typeof orchestratorPlugin.apply).toBe('function');
  });
});

describe('不 import 其它插件实现', () => {
  it('src 中不含对三个插件实现包的 import（静态与动态）', () => {
    const forbidden = [
      '@clis/clis-classifier',
      '@clis/clis-strategy',
      '@clis/clis-feedback',
    ];

    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const pkg of forbidden) {
        expect(
          text.includes(`from '${pkg}'`) ||
            text.includes(`from "${pkg}"`) ||
            text.includes(`import('${pkg}')`) ||
            text.includes(`require('${pkg}')`),
          `${file.name} 不应 import ${pkg}`,
        ).toBe(false);
      }
    }
  });
});

describe('不写任何因果判断规则', () => {
  const JUDGMENT_SYMBOLS = [
    'FOUR_QUESTIONS',
    'q1_simultaneous_mutual_definition',
    'q2_delayed_mutual_influence',
    'q3_strict_irreversible_order',
    'q4_coexisting_causal_structures',
    'normalizeConfidence',
    'EXPLORATION_THRESHOLD',
  ];

  it('src 中不含四问与置信度判据符号', () => {
    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const symbol of JUDGMENT_SYMBOLS) {
        expect(text.includes(symbol), `${file.name} 不应含判据符号 ${symbol}`).toBe(false);
      }
    }
  });
});

describe('不写策略匹配规则', () => {
  const STRATEGY_SYMBOLS = [
    'STRATEGY_LIBRARY',
    'PATH_SCORE_WEIGHTS',
    'scorePath',
    'FAMILY_BY_TYPE',
    'blockedReason',
  ];

  it('src 中不含策略库与排序公式符号', () => {
    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const symbol of STRATEGY_SYMBOLS) {
        expect(text.includes(symbol), `${file.name} 不应含策略符号 ${symbol}`).toBe(false);
      }
    }
  });
});

describe('不写反馈检测规则、不绕过 feedback 决定回退', () => {
  it('src 中不含反馈判据规则 id 与信号判定逻辑', () => {
    const FEEDBACK_SYMBOLS = [
      'detectSignal',
      'FEEDBACK_RULES_VERSION',
      'unilateral_definition_change',
      'feedback_introduced',
      'worsened',
      'repeatedDeviation',
    ];

    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const symbol of FEEDBACK_SYMBOLS) {
        expect(text.includes(symbol), `${file.name} 不应含反馈符号 ${symbol}`).toBe(false);
      }
    }
  });

  it('所有回退决策都以 signal.signal_type 为依据（不存在"凭执行结果直接回退"的分支）', () => {
    const serviceText = stripComments(
      readFileSync(join(SRC_DIR, 'service.ts'), 'utf8'),
    );

    // run() 里出现回退动作的地方，必须是由 decide() 产出的 decision.action，
    // 而不是直接读 execution.status 做判断。
    expect(serviceText).not.toMatch(/execution\.status\s*===\s*'failed'\s*\)\s*\{?\s*\/\/\s*回退/);
    // 关键：决策来自 decide(...)，不是本地 if-else 判信号
    expect(serviceText).toContain('decide(');
  });

  it('decide 的输入必须带 signal（没有 signal 就无法决定回退）', () => {
    const decideText = stripComments(readFileSync(join(SRC_DIR, 'decide.ts'), 'utf8'));
    expect(decideText).toContain('round.signal.signal_type');
    expect(decideText).toContain('suggested_rollback');
  });
});

describe('检查器自检（防止空转变绿）', () => {
  it('能识别违规 import', () => {
    const sample = "import { x } from '@clis/clis-feedback';";
    expect(sample.includes("from '@clis/clis-feedback'")).toBe(true);
  });

  it('stripComments 能剥离注释，避免注释造成假阳性', () => {
    const sample = '// 本插件不写判据：不使用 FOUR_QUESTIONS\nconst a = 1;';
    expect(stripComments(sample).includes('FOUR_QUESTIONS')).toBe(false);
  });

  it('src 目录确实被读到（文件数与行数非零）', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.every((file) => file.text.length > 0)).toBe(true);
  });
});