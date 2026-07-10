/** Detect Postgres/Drizzle errors caused by missing tables or columns. */
export function isSchemaDriftError(error: unknown): boolean {
  const message = String(
    error instanceof Error
      ? `${error.message} ${(error as Error & { cause?: unknown }).cause ?? ''}`
      : error,
  ).toLowerCase();
  return (
    message.includes('does not exist') ||
    message.includes('undefined column') ||
    message.includes('no such column') ||
    message.includes('failed query') ||
    message.includes('column') && message.includes('exist')
  );
}
