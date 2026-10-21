export const DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const DEFAULT_LOGIN_LOCK_DURATION_MS = 30 * 60 * 1000;
export const DEFAULT_LOGIN_FAILURE_WINDOW_MS = 30 * 60 * 1000;

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLoginSecurityConfig() {
  return {
    maxFailedAttempts: positiveInteger(
      process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS,
      DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS
    ),
    lockDurationMs: positiveInteger(
      process.env.AUTH_LOGIN_LOCK_MINUTES,
      DEFAULT_LOGIN_LOCK_DURATION_MS / 60_000
    ) * 60_000,
    failureWindowMs: positiveInteger(
      process.env.AUTH_LOGIN_FAILURE_WINDOW_MINUTES,
      DEFAULT_LOGIN_FAILURE_WINDOW_MS / 60_000
    ) * 60_000,
  };
}

export function isLoginLockActive(lockedUntil: unknown, now = new Date()) {
  if (!lockedUntil) return false;
  const value = lockedUntil instanceof Date ? lockedUntil : new Date(String(lockedUntil));
  return !Number.isNaN(value.getTime()) && value.getTime() > now.getTime();
}

export function shouldResetFailedLoginWindow(
  lastFailedAt: unknown,
  now = new Date(),
  windowMs = DEFAULT_LOGIN_FAILURE_WINDOW_MS
) {
  if (!lastFailedAt) return false;
  const value = lastFailedAt instanceof Date ? lastFailedAt : new Date(String(lastFailedAt));
  return !Number.isNaN(value.getTime()) && now.getTime() - value.getTime() >= windowMs;
}

export function loginRetryAfterSeconds(lockedUntil: unknown, now = new Date()) {
  if (!isLoginLockActive(lockedUntil, now)) return 0;
  const value = lockedUntil instanceof Date ? lockedUntil : new Date(String(lockedUntil));
  return Math.max(1, Math.ceil((value.getTime() - now.getTime()) / 1000));
}
