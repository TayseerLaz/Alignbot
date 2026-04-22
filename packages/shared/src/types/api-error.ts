/**
 * Standard error response shape returned by the Fastify error handler.
 * Frontend toasts and forms read `code` to map to localised messages.
 */
export interface ApiErrorPayload {
  error: {
    code: string; // machine-readable, e.g. "AUTH_INVALID_CREDENTIALS"
    message: string; // human-readable fallback
    details?: unknown; // zod issues, field-level errors, etc.
    requestId?: string;
  };
}

export const ApiErrorCode = {
  // Auth
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_USER_DISABLED: 'AUTH_USER_DISABLED',
  AUTH_NO_MEMBERSHIP: 'AUTH_NO_MEMBERSHIP',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_REFRESH_INVALID: 'AUTH_REFRESH_INVALID',
  AUTH_REQUIRED: 'AUTH_REQUIRED',

  // Authorization
  FORBIDDEN: 'FORBIDDEN',
  ROLE_INSUFFICIENT: 'ROLE_INSUFFICIENT',

  // Resource
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',

  // Tenancy
  TENANT_REQUIRED: 'TENANT_REQUIRED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // Server
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
