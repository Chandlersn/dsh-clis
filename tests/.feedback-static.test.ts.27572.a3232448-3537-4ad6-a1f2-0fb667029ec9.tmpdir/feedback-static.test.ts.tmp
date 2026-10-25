import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as feedbackPlugin from '@clis/clis-feedback';

/**
 * SPEC-feedback §6-4/5：职责边界的静态检查。
 *
 * feedback 的两个禁令最容易在实现里悄悄破防：
 * ① 偷偷重新分类；② 顺手把回退执行了。
 * 这两条只能靠读源码文本来钉。
 */
const SRC_DIR = join(process.cwd(), 'packages', 'clis-feedback', 'src');

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), 'utf8') }));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('SPEC §6-4：不得重新分类', () => {
  it('inject 为空数组 —— 从依赖图层面就无法拿到分类器', () => {
    expect(feedbackPlugin.inject).toStrictEqual([]);
  });

  it('src 不含对 clis-classifier 的 import（静态/动态/require）', () => {
    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      expect(text.includes("from '@clis/clis-classifier'"), `${file.name}`).toBe(false);
      expect(text.includes("import('@clis/clis-classifier')"), `${file.name}`).toBe(false);
      expect(text.includes("require('@clis/clis-classifier')"), `${file.name}`).toBe(false);
    }
  });

  it('src 不含四问与分类判据符号', () => {
    const JUDGMENT_SYMBOLS = [
      'FOUR_QUESTIONS',
      'q1_simultaneous_mutual_definition',
      'q2_delayed_mutual_influence',
      'q3_strict_irreversible_order',
      'q4_coexisting_causal_structures',
      'normalizeConfidence',
      'EXPLORATION_THRESHOLD',
      'CAUSAL_CLASSIFIER_SERVICE',
    ];

    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const symbol of JUDGMENT_SYMBOLS) {
        expect(text.includes(symbol), `${file.name} 不应含 ${symbol}`).toBe(false);
      }
    }
  });
});

describe('SPEC §6-5：不得执行回退', () => {
  it('src 不含策略/编排实现包的 import', () => {
    const forbidden = ['@clis/clis-strategy', '@clis/clis-orchestrator'];
    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const pkg of forbidden) {
        expect(text.includes(`from '${pkg}'`), `${file.name} 不应 import ${pkg}`).toBe(false);
        expect(text.includes(`import('${pkg}')`), `${file.name} 不应动态 import ${pkg}`).toBe(false);
      }
    }
  });

  it('src 不含任何"已执行回退"语义的字段或调用', () => {
    const EXECUTED_TOKENS = ['rollback_performed', 'executed:', 'applyRollback', 'doRollback', 'performRollback'];

    for (const file of sourceFiles()) {
      const text = stripComments(file.text);
      for (const token of EXECUTED_TOKENS) {
        expect(text.includes(token), `${file.name} 不应含 ${token}`).toBe(false);
      }
    }
  });

  it('detectSignal 是同步纯函数（不返回 Promise）', () => {
    const target = {
      result: {
        path_id: 'p1',
        status: 'succeeded' as const,
        signals: [
          { path_id: 'p1', step_index: 0, action: 'a', kind: 'observed' as const, detail: 'ok' },
          { path_id: 'p1', step_index: -1, action: 'summary', kind: 'summary' as const, detail: '汇总' },
        ],
        blocked_actions: [],
      },
      classification: { causal_type: 'cyclic' as const, confidence: 0.9 },
      boundary: { forbidden_actions: [] },
    };

    const returned = feedbackPlugin.detectSignal(target);
    expect(returned).not.toBeInstanceOf(Promise);
    expect(typeof returned.signal_type).toBe('string');
  });
});

describe('检查器自检（防止空转变绿）', () => {
  it('能识别违规 import 文本', () => {
    const sample = "import { x } from '@clis/clis-classifier';";
    expect(sample.includes("from '@clis/clis-classifier'")).toBe(true);
  });

  it('stripComments 能剥离注释，避免说明文字造成假阳性', () => {
    const sample = '// 本插件不判类型：不使用 FOUR_QUESTIONS\nconst a = 1;';
    expect(stripComments(sample).includes('FOUR_QUESTIONS')).toBe(false);
  });

  it('src 目录确实被读到', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.every((file) => file.text.length > 0)).toBe(true);
  });
});