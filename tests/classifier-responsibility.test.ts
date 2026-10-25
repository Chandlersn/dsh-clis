/**
 * SPEC §6 验证方第 12 项 —— 职责边界静态检查。
 *
 * 这是唯一允许读取 `packages/clis-classifier/src/**` 的用例：只做源码文本断言，
 * 不从实现反推任何行为期望值。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'packages', 'clis-classifier', 'src');

/** SPEC §1/§6-12 明确禁止依赖的三个同名插件实现包。 */
const FORBIDDEN_PACKAGES = [
  '@clis/clis-strategy',
  '@clis/clis-feedback',
  '@clis/clis-orchestrator',
];

/** SPEC §1：只允许依赖共享契约包。 */
const ALLOWED_CLIS_PACKAGE = '@clis/clis-contracts';

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

/** 去掉注释，避免文档里提到的包名造成误报（启发式，可能偏宽松）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 收集所有模块说明符：import/export from、动态 import()、require()、副作用 import。 */
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

describe('SPEC §6-12 职责边界静态检查', () => {
  it('packages/clis-classifier/src/** 存在可检查的源码文件（防止静态检查空转变绿）', () => {
    expect(existsSync(SRC_ROOT)).toBe(true);
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('src 不含对 @clis/clis-strategy / @clis/clis-feedback / @clis/clis-orchestrator 的 import', () => {
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

  it('src 依赖的 @clis/* 包只有共享契约包（SPEC §1 只依赖 @clis/clis-contracts）', () => {
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

  it('src 无字面量 1 / 1.0 赋值给 confidence（SPEC §1 禁止 confidence === 1.0）', () => {
    const pattern = /confidence\s*[:=]=?\s*1(?:\.0+)?(?![0-9.])/;
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${index + 1} → ${line.trim()}`);
        }
      });
    }
    expect(violations).toStrictEqual([]);
  });

  it('静态检查器自身的自检：能识别违规样例、且不误伤合法写法', () => {
    const forbiddenSample = "import { plan } from '@clis/clis-strategy';\n";
    expect(
      importSpecifiers(stripComments(forbiddenSample)).some((specifier) =>
        FORBIDDEN_PACKAGES.includes(specifier),
      ),
    ).toBe(true);

    const dynamicSample = "const mod = await import('@clis/clis-orchestrator');\n";
    expect(
      importSpecifiers(stripComments(dynamicSample)).some((specifier) =>
        FORBIDDEN_PACKAGES.includes(specifier),
      ),
    ).toBe(true);

    const commentOnly = "// 这里不 import '@clis/clis-feedback'\n";
    expect(importSpecifiers(stripComments(commentOnly))).toStrictEqual([]);

    const allowedSample = "import { CAUSAL_TYPES } from '@clis/clis-contracts';\n";
    expect(importSpecifiers(stripComments(allowedSample))).toStrictEqual(['@clis/clis-contracts']);

    const onePattern = /confidence\s*[:=]=?\s*1(?:\.0+)?(?![0-9.])/;
    expect(onePattern.test('  confidence: 1,')).toBe(true);
    expect(onePattern.test('  confidence = 1.0;')).toBe(true);
    expect(onePattern.test('  confidence: 0.15,')).toBe(false);
    expect(onePattern.test('  confidence: 0.9,')).toBe(false);
    expect(onePattern.test('  const capped = Math.min(raw, 0.9);')).toBe(false);
  });
});