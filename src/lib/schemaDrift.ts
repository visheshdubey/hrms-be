/** Detect Postgres/Drizzle errors caused by missing tables or columns. */
export function isSchemaDriftError(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  return (
    message.includes('does not exist') ||
    message.includes('undefined column') ||
    message.includes('no such column')
  );
}
