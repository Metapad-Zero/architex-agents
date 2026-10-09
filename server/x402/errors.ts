/**
 * A refusal the caller can act on. Status 402 means the payment itself was the problem and a fresh
 * authorization may fix it; 400 means the request would never work as written.
 */
export class GateError extends Error {
  constructor(
    readonly status: 400 | 402 | 404 | 405 | 409 | 413 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details: { transaction?: `0x${string}`; status?: string; retryable?: boolean; retryAfter?: number } = {},
  ) {
    super(message)
  }
}
