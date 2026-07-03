function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  return "dev-only-jwt-secret-change-me";
}

export const JWT_SECRET = resolveJwtSecret();

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MS_PER_DAY = 86_400_000;
export const RECENT_DAYS = 30;
