import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { CAUSAL_CLASSIFIER_SERVICE } from '@clis/clis-contracts';
import type { CausalClassifierService } from '@clis/clis-contracts';

/**
 * 契约自身的守卫：证明「服务名 → Context 类型增强」这条通路真的成立。
 *
 * 这条通路是四个插件互不 import 实现、却能互相寻址的唯一依据；
 * 一旦契约里的 declare module 失效，编译期就该在这里报错，
 * 而不是等某个插件在运行期拿到 undefined。
 */
describe('契约：Cordis 上下文增强', () => {
  it('服务名常量就是约定值', () => {
    expect(CAUSAL_CLASSIFIER_SERVICE).toBe('clis.causalClassifier');
  });

  it('增强后的 Context 键在编译期解析为 CausalClassifierService', () => {
    const ctx = new Context();

    // 编译期断言：这一行若失去类型增强就会报错。
    const readService = (): CausalClassifierService => ctx[CAUSAL_CLASSIFIER_SERVICE];

    expect(typeof readService).toBe('function');
    // 未装载 clis-classifier 时，该键在运行期确实还不存在。
    expect(ctx[CAUSAL_CLASSIFIER_SERVICE]).toBeUndefined();
  });
});