// services/trips/normalizeTrip.js (ESM)

import { normalizePackingToFourCategoriesSmart } from "../packing/normalizePackingToFourCategoriesSmart.js";

/**
 * Ekstraher JSON fra en LLM-respons (tåler ```json``` blokker og tekst rundt).
 */
export function extractJson(text) {
  if (!text) return null;
  const s0 = String(text).trim();

  // 1) parse hele teksten
  try {
    return JSON.parse(s0);
  } catch {
    // continue
  }

  // 2) ```json ... ```
  const codeBlockMatch = s0.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    const inner = codeBlockMatch[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      // continue
    }
  }

  // 3) finn første { ... siste }
  const a = s0.indexOf("{");
  const b = s0.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) {
    const candidate = s0.slice(a, b + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // give up
    }
  }

  return null;
}

// -------- helpers --------

function safeStr(v) {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

function toNumOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  return /^https?:\/\/\S+/i.test(s.trim());
}

function parseArrayField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    try {
      const p = JSON.parse(t);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Ticket/booking fallback (IKKE maps)
function makeTicketSearchUrl(title, location) {
  const t = safeStr(title);
  const loc = safeStr(location);
  if (!t) return null;
  const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
  return `https://www.google.com/search?q=${q}`;
}

// -------- core --------

export function normalizeTripStructure(input) {
  // input kan være {trip:{...}} eller flat {...}
  const parsed = input && typeof input === "object" ? input : null;
  const root = parsed?.trip && typeof parsed.trip === "object" ? parsed.trip : parsed;

  if (!root) {
    return {
      title: "Reiseforslag fra KI",
      description: null,
      stops: [],
      packing_list: normalizePackingToFourCategoriesSmart([], ""),
      hotels: [],
      experiences: [],
    };
  }

  const title = safeStr(root.title) || "Reiseforslag fra KI";
  const description = safeStr(root.description) || null;

  // ---- stops ----
  const rawStops = parseArrayField(root.stops);

  const stops = rawStops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => {
      const name = safeStr(s.name || s.title || s.label || s.place || s.location) || `Stopp ${idx + 1}`;
      const desc = safeStr(s.description) || "";

      const lat = toNumOrNull(s?.geo?.lat) ?? toNumOrNull(s.lat ?? s.latitude);
      const lng = toNumOrNull(s?.geo?.lng) ?? toNumOrNull(s.lng ?? s.lon ?? s.longitude);

      let day = s.day ?? s.order ?? null;
      day = typeof day === "number" ? day : toNumOrNull(day);
      if (day == null) day = idx + 1;

      const location = safeStr(s.location || s.address || s.subtitle || s.city || s.area) || null;

      // hotels på stop (valgfritt)
      const stopHotels = parseArrayField(s.hotels)
        .filter((h) => h && typeof h === "object")
        .map((h, hi) => {
          const hn = safeStr(h.name || h.title) || `Hotell ${hi + 1}`;
          const hl = safeStr(h.location || h.area || h.city) || null;
          const hd = safeStr(h.description || h.notes) || "";

          const price =
            typeof h.price_per_night === "number"
              ? h.price_per_night
              : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

          const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
          const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

          return { name: hn, location: hl, description: hd, price_per_night: price ?? null, url };
        })
        .filter((h) => safeStr(h.name));

      return {
        id: s.id ?? `s-${idx + 1}`,
        day,
        name,
        description: desc,
        location,
        lat: lat ?? null,
        lng: lng ?? null,
        hotels: stopHotels,
      };
    })
    .filter((s) => safeStr(s.name));

  // ---- packing_list -> 4 kategorier ----
  const rawPacking =
    root.packing_list ||
    root.packingList ||
    root.packing ||
    [];

  const contextText =
    `${title}\n${description || ""}\n` +
    stops.map((s) => `${safeStr(s.name)} ${safeStr(s.description)}`).join("\n");

  const packing_list = normalizePackingToFourCategoriesSmart(rawPacking, contextText);

  // ---- hotels (flat) + inkluder evt. hotels fra stops ----
  const rawHotelsCombined = [
    ...parseArrayField(root.hotels),
    ...stops.flatMap((s) => (Array.isArray(s.hotels) ? s.hotels : [])),
  ];

  const hotels = rawHotelsCombined
    .filter((h) => h && typeof h === "object")
    .map((h, idx) => {
      const name = safeStr(h.name || h.title) || `Hotell ${idx + 1}`;
      const location = safeStr(h.location || h.area || h.city) || null;
      const descriptionH = safeStr(h.description || h.notes) || "";

      const price =
        typeof h.price_per_night === "number"
          ? h.price_per_night
          : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

      const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
      const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

      return {
        id: h.id ?? `h-${idx + 1}`,
        name,
        location,
        description: descriptionH,
        price_per_night: price ?? null,
        url,
      };
    })
    .filter((h) => safeStr(h.name));

  // ---- experiences ----
  const rawExperiences =
    parseArrayField(root.experiences).length
      ? parseArrayField(root.experiences)
      : parseArrayField(root.activities || root.tickets || root.bookings);

  const experiences = rawExperiences
    .filter((x) => x && typeof x === "object")
    .map((x, idx) => {
      const name = safeStr(x.title || x.name || x.activity) || `Opplevelse ${idx + 1}`;
      const location = safeStr(x.location || x.city || x.area) || null;
      const descriptionX = safeStr(x.description) || "";

      const rawUrl = safeStr(
        x.booking_url || x.url || x.ticket_url || x.link || x.external_url
      ) || null;

      const url = rawUrl
        ? (isHttpUrl(rawUrl) ? rawUrl : null)
        : makeTicketSearchUrl(name, location);

      const day = typeof x.day === "number" ? x.day : toNumOrNull(x.day);

      const price_per_person =
        typeof x.price_per_person === "number"
          ? x.price_per_person
          : toNumOrNull(x.price_per_person);

      const currency = safeStr(x.currency) || "NOK";

      return {
        id: x.id ?? `exp-${idx + 1}`,
        name,
        location,
        description: descriptionX,
        url,
        day: day ?? null,
        price_per_person: price_per_person ?? null,
        currency,
      };
    })
    .filter((e) => safeStr(e.name));

  return {
    title,
    description,
    stops,
    packing_list,
    hotels,
    experiences,
  };
}

/**
 * Praktisk helper hvis du ofte starter fra AI-tekst:
 */
export function normalizeTripFromText(aiText) {
  const parsed = extractJson(aiText);
  return normalizeTripStructure(parsed);
}
