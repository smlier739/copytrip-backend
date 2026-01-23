// backend/services/utils/tripStops.js (ESM)

function safeStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

export function toNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;

  const s = String(v ?? "").trim();
  if (!s) return null;

  // støtt komma-desimal
  const normalized = s.replace(",", ".");
  const n = Number(normalized);

  return Number.isFinite(n) ? n : null;
}

export function toArrayMaybe(v) {
  if (v == null) return [];

  // allerede array
  if (Array.isArray(v)) return v;

  // JSON-string
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      return toArrayMaybe(JSON.parse(s));
    } catch {
      return [];
    }
  }

  // objekt som inneholder stops-array
  if (typeof v === "object") {
    if (Array.isArray(v.stops)) return v.stops;
    if (Array.isArray(v.items)) return v.items;
    if (Array.isArray(v.data)) return v.data;

    // noen ganger kommer det som map: {"0": {...}, "1": {...}}
    const values = Object.values(v);
    if (values.some((x) => x && typeof x === "object")) {
      return values.filter((x) => x && typeof x === "object");
    }
  }

  return [];
}

export function pickStop1(stops) {
  const arr = toArrayMaybe(stops);
  const s1 = arr[0];
  return s1 && typeof s1 === "object" ? s1 : null;
}

export function pickLatLngFromStop(stop) {
  if (!stop || typeof stop !== "object") return null;

  // 1) direkte felt
  const lat =
    toNum(stop.lat) ??
    toNum(stop.latitude) ??
    toNum(stop?.coords?.lat) ??
    toNum(stop?.coords?.latitude) ??
    toNum(stop?.geo?.lat) ??
    toNum(stop?.geo?.latitude) ??
    toNum(stop?.location?.lat) ??
    toNum(stop?.location?.latitude);

  const lng =
    toNum(stop.lng) ??
    toNum(stop.lon) ??
    toNum(stop.longitude) ??
    toNum(stop?.coords?.lng) ??
    toNum(stop?.coords?.lon) ??
    toNum(stop?.coords?.longitude) ??
    toNum(stop?.geo?.lng) ??
    toNum(stop?.geo?.lon) ??
    toNum(stop?.geo?.longitude) ??
    toNum(stop?.location?.lng) ??
    toNum(stop?.location?.lon) ??
    toNum(stop?.location?.longitude);

  if (typeof lat === "number" && typeof lng === "number") {
    return { lat, lng };
  }

  // 2) array-format: [lng, lat] (Mapbox/GeoJSON center/coordinates)
  const coordsArr =
    (Array.isArray(stop.coordinates) && stop.coordinates) ||
    (Array.isArray(stop.center) && stop.center) ||
    (Array.isArray(stop?.geo?.center) && stop.geo.center) ||
    (Array.isArray(stop?.geo?.coordinates) && stop.geo.coordinates) ||
    (Array.isArray(stop?.location?.coordinates) && stop.location.coordinates);

  if (Array.isArray(coordsArr) && coordsArr.length >= 2) {
    const lng2 = toNum(coordsArr[0]);
    const lat2 = toNum(coordsArr[1]);
    if (typeof lat2 === "number" && typeof lng2 === "number") {
      return { lat: lat2, lng: lng2 };
    }
  }

  return null;
}

export function pickTextFromStop(stop) {
  if (!stop || typeof stop !== "object") return null;

  // prioriter "rene" tekstfelt først
  const name =
    safeStr(stop.name) ||
    safeStr(stop.title) ||
    safeStr(stop.place) ||
    safeStr(stop.city) ||
    safeStr(stop.destination) ||
    safeStr(stop.address) ||
    safeStr(stop.area);

  // unngå at location (objekt) blir "[object Object]"
  const locText =
    safeStr(stop.location) ||
    safeStr(stop?.location?.name) ||
    safeStr(stop?.location?.city) ||
    safeStr(stop?.location?.address);

  const country =
    safeStr(stop.country) ||
    safeStr(stop.countryName) ||
    safeStr(stop?.location?.country) ||
    safeStr(stop?.location?.countryName);

  const parts = [name || locText, country]
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter(Boolean);

  return parts.length ? parts.join(", ") : null;
}
