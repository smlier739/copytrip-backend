// backend/services/travelpayouts/flightsCache.js (ESM)

const g = globalThis;

// search_id -> { results_url, created_at, offer_to_tp_proposal? }
export const flightSearchCache =
  g.flightSearchCache || (g.flightSearchCache = new Map());

// click_id -> { ... }
export const flightClickCache =
  g.flightClickCache || (g.flightClickCache = new Map());

// --- TTL helpers ---
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 time

export function cacheSet(map, key, value) {
  map.set(key, { ...value, created_at: Date.now() });
}

export function cacheGet(map, key, ttlMs = DEFAULT_TTL_MS) {
  const v = map.get(key);
  if (!v) return null;

  const created = typeof v.created_at === "number" ? v.created_at : 0;
  if (created && Date.now() - created > ttlMs) {
    map.delete(key);
    return null;
  }
  return v;
}

export function cacheSweep(map, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    const created = typeof v?.created_at === "number" ? v.created_at : 0;
    if (!created || now - created > ttlMs) map.delete(k);
  }
}
