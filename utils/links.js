// backend/utils/links.js
import { sanitizeUrl } from "./url.js";

// Bruk søk-fallback (ikke Maps) hvis ingen eksplisitt URL finnes
export function makeHotelUrl(h) {
  // 1) Direkte URL-felter
  const direct =
    sanitizeUrl(h?.url) ||
    sanitizeUrl(h?.booking_url) ||
    sanitizeUrl(h?.link) ||
    sanitizeUrl(h?.external_url);

  if (direct) return direct;

  // 2) Fallback: Booking-søk
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();

  if (!name) return null;

  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(
    location ? `${name} ${location}` : name
  )}`;
}

export function makeExperienceUrl(x) {
  const direct =
    sanitizeUrl(x?.url) ||
    sanitizeUrl(x?.booking_url) ||
    sanitizeUrl(x?.ticket_url) ||
    sanitizeUrl(x?.link) ||
    sanitizeUrl(x?.external_url);

  if (direct) return direct;

  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();
  if (!name) return null;

  const q = encodeURIComponent(
    location ? `${name} ${location} billetter` : `${name} billetter`
  );

  return `https://www.google.com/search?q=${q}`;
}
