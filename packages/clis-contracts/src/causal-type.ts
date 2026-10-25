/**
 * 因果类型词表 —— CLIS 的骨架。
 *
 * 类型不是标签，而是"该用哪套因果逻辑去推"的依据：
 * - structural_duality：A 与 B 同时成立、彼此定义、无时间先后（正与反、买与卖）。
 * - cyclic：A→B→A，存在时间延迟，可能振荡（供需-价格、捕食者-猎物）。
 * - unidirectional：A→B，严格先后、不可逆（火→热、雨→地湿）。
 * - nested：系统内同时存在多种因果结构，必须拆子模块分别处理。
 * - unknown：四问无法明确判断 —— 显式的"拒绝强行归类"，进入探索模式。
 */
export const CAUSAL_TYPES = [
  'structural_duality',
  'cyclic',
  'unidirectional',
  'nested',
  'unknown',
] as const;

/** 因果类型。unknown 是一个结论，不是一个可执行策略的类型。 */
export type CausalType = (typeof CAUSAL_TYPES)[number];

/** 四种"确定"的因果类型。 */
export const KNOWN_CAUSAL_TYPES = [
  'structural_duality',
  'cyclic',
  'unidirectional',
  'nested',
] as const;

export type KnownCausalType = (typeof KNOWN_CAUSAL_TYPES)[number];

export function isCausalType(value: unknown): value is CausalType {
  return typeof value === 'string' && (CAUSAL_TYPES as readonly string[]).includes(value);
}

export function isKnownCausalType(value: unknown): value is KnownCausalType {
  return typeof value === 'string' && (KNOWN_CAUSAL_TYPES as readonly string[]).includes(value);
}