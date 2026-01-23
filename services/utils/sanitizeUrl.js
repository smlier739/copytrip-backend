// backend/services/utils/sanitizeUrl.js (ESM)

export function sanitizeUrl(u) {
  if (typeof u !== "string") return null;

  // Trim + fjern kontrolltegn/newlines som kan gi rare URLer
  const s = u.trim().replace(/[\u0000-\u001F\u007F\s]+/g, " ");
  if (!s) return null;

  // Legg til https:// hvis mangler
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;

  // Blokker typiske placeholder-domener
  const lower = withProto.toLowerCase();
  if (
    lower.includes("example.com") ||
    lower.includes("example.org") ||
    lower.includes("example.net")
  ) {
    return null;
  }

  // Valider med URL og tillat kun http/https
  try {
    const url = new URL(withProto);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    // Må ha host (ikke bare path)
    if (!url.hostname) return null;

    // Returner normalisert URL (fjerner f.eks. spaces)
    return url.toString();
  } catch {
    return null;
  }
}
