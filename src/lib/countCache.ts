/**
 * Short-lived in-memory count cache for hot list endpoints.
 * Avoids repeating COUNT(*) on every page flip (critical at 50k–1M rows).
 */
type CacheEntry = { total: number; expiresAt: number };

const store = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 45_000;

export function getCachedCount(key: string): number | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.total;
}

export function setCachedCount(key: string, total: number, ttlMs = DEFAULT_TTL_MS): void {
  store.set(key, { total, expiresAt: Date.now() + ttlMs });
}

export function invalidateCountCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
