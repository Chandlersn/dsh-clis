/**
 * SPEC-strategy §7 验证方第 11 项 —— 职责边界静态检查。
 *
 * 这是唯一允许读取 `packages/clis-strategy/src/**` 的用例：只做源码文本断言，
 * 不从实现反推任何行为期望值。
 *
 * 说明：扫描器与 `classifier-responsibility.test.ts` 各自独立实现（刻意不抽公共模块），
 * 以免改动已交付并已在报告中冻结哈希的 clis-classifier 验收文件。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'packages', 'clis-strategy', 'src');

/** SPEC §1/§7-11 明确禁止依赖的两个同名插件实现包。 */
const FORBIDDEN_PACKAGES = ['@clis/clis-feedback', '@clis/clis-orchestrator'];

/** SPEC §1：只允许依赖共享契约包。 */
const ALLOWED_CLIS_PACKAGE = '@clis/clis-contracts';

/**
 * SPEC §7-11「不得出现分类器判据符号」。
 * 刻意**不**列入 `CausalClassification` / `CausalType` / `KNOWN_CAUSAL_TYPES` /
 * `CAUSAL_CLASSIFIER_SERVICE`：这些是"读取类型"与声明 inject 所必需，属合法依赖。
 */
const CLASSIFIER_JUDGMENT_SYMBOLS = [
  'FOUR_QUESTIONS',
  'ANSWER_KEYS',
  'TRI_STATES',
  'isTriState',
  'q1_simultaneous_mutual_definition',
  'q2_delayed_mutual_influence',
  'q3_strict_irreversible_order',
  'q4_coexisting_causal_structures',
  'classifyProblem',
  'ClassifierService',
  'normalizeConfidence',
];

/** SPEC §1/§6.6：执行结果不得出现回退决策字段。 */
const ROLLBACK_TOKENS = /rollback|next_action|suggested_rollback/i;

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function listSourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_FILE.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** 去注释（启发式）：避免文档/注释里提到的名字造成误报。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importSpecifiers(source: string): string[] {
  const patterns: readonly RegExp[] = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*(?:import|export)\s+['"]([^'"]+)['"]/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const captured = match[1];
      if (typeof captured === 'string' && captured.length > 0) specifiers.push(captured);
    }
  }
  return specifiers;
}

const sourceFiles = listSourceFiles(SRC_ROOT);

describe('SPEC §7-11 职责边界静态检查', () => {
  it('packages/clis-strategy/src/** 存在可检查的源码文件（防止静态检查空转变绿）', () => {
    expect(existsSync(SRC_ROOT)).toBe(true);
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('src 不含对 @clis/clis-feedback / @clis/clis-orchestrator 的 import', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of importSpecifiers(source)) {
        const hit = FORBIDDEN_PACKAGES.some(
          (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
        );
        if (hit) violations.push(`${relative(REPO_ROOT, file)} → ${specifier}`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('src 依赖的 @clis/* 包只有共享契约包（SPEC §1）', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('@clis/')) continue;
        const allowed =
          specifier === ALLOWED_CLIS_PACKAGE || specifier.startsWith(`${ALLOWED_CLIS_PACKAGE}/`);
        if (!allowed) violations.push(`${relative(REPO_ROOT, file)} → ${specifier}`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('src 不含分类器判据符号（不重新判断因果类型）', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const symbol of CLASSIFIER_JUDGMENT_SYMBOLS) {
          if (line.includes(symbol)) {
            violations.push(`${relative(REPO_ROOT, file)}:${index + 1} → ${symbol}`);
          }
        }
      });
    }
    expect(violations).toStrictEqual([]);
  });

  it('src 不含 rollback / next_action 之类回退字段标识', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (ROLLBACK_TOKENS.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${index + 1} → ${line.trim()}`);
        }
      });
    }
    expect(violations).toStrictEqual([]);
  });

  it('扫描器自检：能识别违规样例，且不误伤合法写法与注释', () => {
    // 能识别静态 / 动态 import 与 require
    expect(
      importSpecifiers(stripComments("import { x } from '@clis/clis-feedback';\n")),
    ).toContain('@clis/clis-feedback');
    expect(
      importSpecifiers(stripComments("const m = await import('@clis/clis-orchestrator');\n")),
    ).toContain('@clis/clis-orchestrator');
    expect(
      importSpecifiers(stripComments("const m = require('@clis/clis-feedback');\n")),
    ).toContain('@clis/clis-feedback');

    // 判据符号能被识别
    expect(CLASSIFIER_JUDGMENT_SYMBOLS.some((s) => '  const x = FOUR_QUESTIONS[0]'.includes(s))).toBe(true);

    // 不误伤：合法契约符号、inject 常量、注释里提到的判据符号
    const legit = stripComments(
      [
        "import { CAUSAL_CLASSIFIER_SERVICE, scorePath } from '@clis/clis-contracts';",
        'import type { CausalClassification, CausalType } from "@clis/clis-contracts";',
        '// 本插件不判类型：不使用 FOUR_QUESTIONS / q1_simultaneous_mutual_definition',
        'const family = FAMILY_BY_TYPE[classification.causal_type as KnownCausalType];',
      ].join('\n'),
    );
    for (const symbol of CLASSIFIER_JUDGMENT_SYMBOLS) {
      expect(legit.includes(symbol)).toBe(false);
    }
    expect(importSpecifiers(legit)).toStrictEqual(['@clis/clis-contracts', '@clis/clis-contracts']);

    // 回退字样能被识别，且注释/文档里的说明不算
    expect(ROLLBACK_TOKENS.test('  suggested_rollback: null,')).toBe(true);
    expect(ROLLBACK_TOKENS.test(stripComments('// 不决定回退，也不给 rollback 建议'))).toBe(false);
  });
});