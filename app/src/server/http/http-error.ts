import type { ApiError } from '../../shared/api.js';

/** An error with an explicit HTTP status and a body that is safe to show to the caller. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError & Record<string, unknown>,
  ) {
    super(body.message);
  }
}
