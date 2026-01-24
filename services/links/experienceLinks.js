// backend/services/links/experienceLinks.js (ESM)

import { sanitizeUrl as sanitizeUrlImported } from "../utils/sanitizeUrl.js";

/**
 * Local safe wrapper so we don't crash if sanitizeUrl is missing/not a function.
 */
function sanitizeUrlSafe(value) {
  try {
    if (typeof sanitizeUrlImported === "function") {
      return sanitizeUrlImported(value);
    }
  } catch {
    // ignore
  }

  // Minimal fallback sanitizing (http/https only)
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^https?:\/\/\S+/i.test(s)) return null;
  return s;
}

/**
 * Ticket/booking fallback (search – NOT Google Maps).
 */
function makeExperienceFallbackUrl(e) {
  const name = (e?.name || e?.title || e?.activity || "").toString().trim();
  const location = (e?.location || e?.city || e?.area || "").toString().trim();
  if (!name) return null;

  const q = encodeURIComponent(location ? `${name} ${location} billetter` : `${name} billetter`);
  return `https://www.google.com/search?q=${q}`;
}

/**
 * Normalizes various possible URL fields and returns a usable URL.
 * - Prefers explicit booking/ticket URLs if valid.
 * - Falls back to safe search URL if none.
 */
export function makeExperienceUrl(e) {
  const candidate =
    e?.booking_url ??
    e?.bookingUrl ??
    e?.ticket_url ??
    e?.ticketUrl ??
    e?.url ??
    e?.link ??
    e?.external_url ??
    e?.externalUrl ??
    null;

  return sanitizeUrlSafe(candidate) || makeExperienceFallbackUrl(e);
}
