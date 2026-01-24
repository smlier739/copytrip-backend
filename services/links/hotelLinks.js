// backend/services/links/hotelLinks.js (ESM)

import { sanitizeUrl } from "../utils/sanitizeUrl.js";

// -----------------------------------------------------
// Fallback: Booking.com-søk (foretrukket for hoteller)
// -----------------------------------------------------
function makeHotelFallbackUrl(h) {
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();

  if (!name) return null;

  const search = location ? `${name} ${location}` : name;

  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(
    search
  )}`;
}

// -----------------------------------------------------
// Hovedfunksjon
// -----------------------------------------------------
export function makeHotelUrl(h) {
  if (!h || typeof h !== "object") return null;

  // 1) Prøv eksplisitte URL-felter først
  const direct =
    sanitizeUrl(h.url) ||
    sanitizeUrl(h.booking_url) ||
    sanitizeUrl(h.link) ||
    sanitizeUrl(h.external_url);

  if (direct) return direct;

  // 2) Fallback: Booking.com-søk
  return makeHotelFallbackUrl(h);
}
