export type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'PROFILE_NOT_FOUND'
  | 'NOT_LOGGED_IN'
  | 'CLOUDFLARE_BLOCKED'
  | 'BROWSER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INVALID_INPUT';

export class MakerWorldError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'MakerWorldError';
  }
}
