import type { ErrorCode, TaskView } from '../../shared/types.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  NO_CHANGE: 422,
  INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LOAD_FAILED: 503,
  SAVE_FAILED: 503,
  BAD_HOST: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { details?: Array<{ path: string; message: string }>; current?: TaskView } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

export const notFoundTask = () => new AppError('NOT_FOUND', 'タスクが見つからないか、表示する権限がありません。');
