// backend/utils/url.js (ESM)

export function sanitizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!/^https?:\/\/\S+/i.test(s)) return null;
  return s;
}
