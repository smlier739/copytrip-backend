// services/trips/extractDestinationFromStop1.js (ESM)

/**
 * Tåler:
 * - array
 * - JSON-string (typisk fra jsonb/text)
 * - null/undefined
 */
function asArrayJsonb(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function toNumOrNull(x) {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim()) {
    const n = Number(x.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Forsøk å hente en "destinasjon" fra stop 1 på tvers av mulige stop-skjema
export function extractDestinationFromStop1(stops) {
  const arr = asArrayJsonb(stops);
  const s0 = arr[0];

  if (!s0 || typeof s0 !== "object") return null;

  // typiske felter i stops
  const name =
    s0.name ??
    s0.title ??
    s0.place_name ??
    s0.placeName ??
    s0.label ??
    s0.city ??
    s0.locationName ??
    null;

  const country = s0.country ?? s0.countryName ?? null;

  // iata kan ligge flere steder
  const iata =
    s0.iata ??
    s0.city_iata ??
    s0.destination_iata ??
    s0.airport_iata ??
    s0.airportIata ??
    s0.airport?.iata ??
    s0.airport?.IATA ??
    null;

  // Viktig: ikke bruk "&& s0.lat" osv. (0 blir feilaktig falsy)
  const lat =
    toNumOrNull(s0.lat) ??
    toNumOrNull(s0.latitude) ??
    toNumOrNull(s0.coords?.lat) ??
    toNumOrNull(s0.coords?.latitude) ??
    toNumOrNull(s0.coordinate?.lat) ??
    toNumOrNull(s0.coordinate?.latitude) ??
    null;

  const lng =
    toNumOrNull(s0.lng) ??
    toNumOrNull(s0.lon) ??
    toNumOrNull(s0.longitude) ??
    toNumOrNull(s0.coords?.lng) ??
    toNumOrNull(s0.coords?.lon) ??
    toNumOrNull(s0.coords?.longitude) ??
    toNumOrNull(s0.coordinate?.lng) ??
    toNumOrNull(s0.coordinate?.lon) ??
    toNumOrNull(s0.coordinate?.longitude) ??
    null;

  const out = {
    name: name != null ? String(name).trim() : null,
    country: country != null ? String(country).trim() : null,
    iata: iata != null ? String(iata).trim().toUpperCase() : null,
    lat,
    lng,
    raw: s0, // OK for debug; fjern om du ikke vil eksponere rådata
  };

  // Hvis alt er tomt -> null
  if (!out.name && !out.country && !out.iata && out.lat == null && out.lng == null) return null;

  return out;
}
