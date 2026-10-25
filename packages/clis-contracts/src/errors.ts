/** 契约级错误码。畸形输入必须显式抛错，绝不静默产出一个看似合理的分类。 */
export type ClisContractErrorCode =
  | 'INVALID_PROBLEM'
  | 'INVALID_ANSWERS'
  | 'INVALID_OPTIONS'
  | 'INVALID_CLASSIFICATION'
  | 'INVALID_BOUNDARY'
  | 'INVALID_PATH';

/** 一条字段级错误说明，便于调用方直接定位。 */
export interface ClisContractErrorDetail {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

export class ClisContractError extends Error {
  readonly code: ClisContractErrorCode;
  readonly details: readonly ClisContractErrorDetail[];

  constructor(
    code: ClisContractErrorCode,
    message: string,
    details: readonly ClisContractErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ClisContractError';
    this.code = code;
    this.details = details;
  }
}