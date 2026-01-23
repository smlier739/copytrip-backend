// utils/stops.js
import { randomUUID } from "crypto";

function toNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

export function normalizeStop(stop, ord) {
  const s = stop && typeof stop === "object" ? stop : {};

  const lat =
    toNum(s?.geo?.lat) ??
    toNum(s?.lat) ??
    toNum(s?.latitude) ??
    null;

  const lng =
    toNum(s?.geo?.lng) ??
    toNum(s?.lng) ??
    toNum(s?.lon) ??
    toNum(s?.longitude) ??
    null;

  const iata =
    str(s?.codes?.iata) ??
    str(s?.iata) ??
    str(s?.destination_iata) ??
    str(s?.city_iata) ??
    null;

  const cityIata =
    str(s?.codes?.cityIata) ??
    str(s?.cityIata) ??
    str(s?.city_iata) ??
    null;

  const hotellookCityId =
    toNum(s?.codes?.hotellookCityId) ??
    toNum(s?.hotellookCityId) ??
    toNum(s?.hotellook_city_id) ??
    null;

  const name =
    str(s?.name) ??
    str(s?.title) ??
    str(s?.label) ??
    str(s?.place) ??
    str(s?.location) ??
    `Stopp ${ord}`;

  const out = {
    id: str(s?.id) ?? `stop_${ord}_${randomUUID().slice(0, 8)}`,
    order: Number.isFinite(Number(s?.order)) ? Number(s.order) : ord,
    name,
    countryCode: str(s?.countryCode) ?? str(s?.country_code) ?? str(s?.country) ?? null,
    region: str(s?.region) ?? str(s?.state) ?? str(s?.province) ?? null,
    type: str(s?.type) ?? "destination",
    geo: (lat != null && lng != null) ? { lat, lng } : null,
    codes: {
      iata,
      cityIata,
      hotellookCityId: hotellookCityId != null ? Math.trunc(hotellookCityId) : null,
    },
    search: (s?.search && typeof s.search === "object") ? s.search : {},
    meta: {
      ...(s?.meta && typeof s.meta === "object" ? s.meta : {}),
      original: s, // bevar input
    },
  };

  // Rydd bort nuller/undefined på toppnivå:
  if (!out.geo) delete out.geo;
  if (!out.codes?.iata && !out.codes?.cityIata && !out.codes?.hotellookCityId) delete out.codes;
  if (!out.search || Object.keys(out.search).length === 0) delete out.search;

  return out;
}

export function normalizeStops(stops) {
  const arr = Array.isArray(stops) ? stops : [];
  const normalized = arr.map((s, idx) => normalizeStop(s, idx + 1));

  // Sørg for stabil sortering på order
  normalized.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return normalized;
}
