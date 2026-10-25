import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import { CAUSAL_FEEDBACK_SERVICE } from '@clis/clis-contracts';
import type {
  DetectOptions,
  FeedbackRequest,
  FeedbackService,
  FeedbackSignal,
} from '@clis/clis-contracts';

import { detectSignal } from './detect';

/**
 * 反馈服务的 Cordis 实现。
 *
 * 无任何服务依赖（`inject: []`）—— 从依赖图层面就无法调用 classifier 重新分类。
 */
export class FeedbackServiceImpl extends Service implements FeedbackService {
  constructor(ctx: Context) {
    super(ctx, CAUSAL_FEEDBACK_SERVICE);
  }

  /** 与纯函数 detectSignal 结论完全一致的异步包装。 */
  async detect(request: FeedbackRequest, options?: DetectOptions): Promise<FeedbackSignal> {
    return detectSignal(request, options);
  }
}