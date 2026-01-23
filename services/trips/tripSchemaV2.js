// backend/services/trips/tripSchemaV2.js (ESM)

function toNumOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cleanStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  return /^https?:\/\/\S+/i.test(s.trim());
}

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return fallback;
    try {
      return JSON.parse(t);
    } catch {
      return fallback;
    }
  }
  return value;
}

function parseArrayMaybeJson(value) {
  const v = parseMaybeJson(value, []);
  return Array.isArray(v) ? v : [];
}

function parseObjectMaybeJson(value) {
  const v = parseMaybeJson(value, null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

// ---------------------------
// Stops: V1-ish -> V2 schema
// ---------------------------

function normalizeStopToV2(stop, ord) {
  const s = stop && typeof stop === "object" ? stop : {};

  const id =
    (typeof s.id === "string" && s.id.trim())
      ? s.id.trim()
      : `stop_${ord}`;

  const orderRaw = s.order ?? s.day ?? s.ord ?? ord;
  const order = Math.max(1, Math.round(toNumOrNull(orderRaw) ?? ord));

  const name =
    cleanStr(s.name || s.title || s.label || s.place || s.location || `Stopp ${ord}`) ||
    `Stopp ${ord}`;

  const description = cleanStr(s.description || "");

  // country / region (best effort)
  const countryCode =
    cleanStr(s.countryCode || s.country_code || s.country || "") || null;

  const region =
    cleanStr(s.region || s.state || s.province || "") || null;

  const type = cleanStr(s.type || "") || "destination";

  const lat =
    toNumOrNull(s?.geo?.lat) ??
    toNumOrNull(s.lat ?? s.latitude) ??
    null;

  const lng =
    toNumOrNull(s?.geo?.lng) ??
    toNumOrNull(s.lng ?? s.lon ?? s.longitude) ??
    null;

  // codes best effort
  const iata =
    (typeof s?.codes?.iata === "string" && s.codes.iata.trim())
      ? s.codes.iata.trim().toUpperCase()
      : (typeof s.iata === "string" && s.iata.trim())
      ? s.iata.trim().toUpperCase()
      : null;

  const cityIata =
    (typeof s?.codes?.cityIata === "string" && s.codes.cityIata.trim())
      ? s.codes.cityIata.trim().toUpperCase()
      : (typeof s.cityIata === "string" && s.cityIata.trim())
      ? s.cityIata.trim().toUpperCase()
      : null;

  const hotellookCityIdRaw =
    s?.codes?.hotellookCityId ?? s.hotellookCityId ?? s.hotellook_city_id ?? null;

  const hotellookCityId = (() => {
    const n = toNumOrNull(hotellookCityIdRaw);
    return Number.isFinite(n) ? Math.round(n) : null;
  })();

  const out = {
    id,
    order,
    name,
    description,
    ...(countryCode ? { countryCode } : {}),
    ...(region ? { region } : {}),
    type,
    ...(lat == null && lng == null ? {} : { geo: { lat, lng } }),
    ...(
      iata || cityIata || hotellookCityId != null
        ? {
            codes: {
              ...(iata ? { iata } : {}),
              ...(cityIata ? { cityIata } : {}),
              ...(hotellookCityId != null ? { hotellookCityId } : {}),
            },
          }
        : {}
    ),
    // disse brukes flere steder hos deg
    search: (s.search && typeof s.search === "object") ? s.search : {},
    meta:
      (s.meta && typeof s.meta === "object")
        ? (s.meta.original ? s.meta : { ...s.meta, original: stop })
        : { original: stop },
  };

  return out;
}

export function normalizeStopsV1toV2(stopsRaw) {
  const arr = parseArrayMaybeJson(stopsRaw);

  const out = arr
    .filter((x) => x && typeof x === "object")
    .map((x, idx) => normalizeStopToV2(x, idx + 1))
    .filter((s) => s?.name);

  out.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  return out;
}

// ---------------------------
// Packing list (4 kategorier)
// ---------------------------

const PACKING_CATS = ["Klær", "Toalettsaker", "Elektronikk", "Annet"];

function dedupeStrings(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const t = cleanStr(it);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function normalizePackingListV2(rawPacking) {
  let v = rawPacking;

  // JSON-string -> parse
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) v = [];
    else {
      try {
        v = JSON.parse(t);
      } catch {
        // plain text -> split
        v = t
          .split(/[\n,]/)
          .map((x) => cleanStr(x))
          .filter(Boolean);
      }
    }
  }

  const buckets = new Map(PACKING_CATS.map((c) => [c, []]));

  // A) array
  if (Array.isArray(v)) {
    // array av strings -> putt i Annet (best effort)
    if (v.every((x) => typeof x === "string")) {
      buckets.set("Annet", dedupeStrings(v).slice(0, 10));
    } else {
      // array av {category, items}
      for (const g of v) {
        if (!g || typeof g !== "object") continue;
        const cat = cleanStr(g.category);
        if (!PACKING_CATS.includes(cat)) continue;

        const items =
          Array.isArray(g.items) ? g.items :
          typeof g.items === "string" ? g.items.split(/[\n,]/) :
          [];

        buckets.set(cat, dedupeStrings(items).slice(0, 10));
      }
    }
  }
  // B) object-map {Klær:[..], ...}
  else if (v && typeof v === "object") {
    for (const cat of PACKING_CATS) {
      const items = v?.[cat];
      if (Array.isArray(items)) {
        buckets.set(cat, dedupeStrings(items).slice(0, 10));
      } else if (typeof items === "string" && items.trim()) {
        buckets.set(cat, dedupeStrings(items.split(/[\n,]/)).slice(0, 10));
      }
    }
  }

  // Sikre nøyaktig 4 elementer
  return PACKING_CATS.map((cat) => ({
    category: cat,
    items: (buckets.get(cat) || []).slice(0, 10),
  }));
}

// ---------------------------
// Hotels
// ---------------------------

export function normalizeHotelsV2(rawHotels) {
  const arr = parseArrayMaybeJson(rawHotels);

  return arr
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      name: cleanStr(h.name || h.title || "Hotell") || "Hotell",
      location:
        h.location ? cleanStr(h.location) :
        h.city ? cleanStr(h.city) :
        h.area ? cleanStr(h.area) :
        null,
      description:
        h.description ? cleanStr(h.description) :
        h.notes ? cleanStr(h.notes) :
        null,
      price_per_night:
        typeof h.price_per_night === "number"
          ? h.price_per_night
          : toNumOrNull(h.price_per_night ?? h.approx_price_per_night),
      currency: cleanStr(h.currency || "NOK") || "NOK",
      url: isHttpUrl(h.url) ? cleanStr(h.url) : null,
    }))
    .filter((h) => h.name)
    .slice(0, 12);
}

// ---------------------------
// Experiences
// ---------------------------

export function normalizeExperiencesV2(rawExps) {
  const arr = parseArrayMaybeJson(rawExps);

  return arr
    .filter((e) => e && typeof e === "object")
    .map((e, idx) => ({
      id: e.id ?? `exp-${idx + 1}`,
      title:
        cleanStr(e.title || e.name || e.activity || `Opplevelse ${idx + 1}`) ||
        `Opplevelse ${idx + 1}`,
      location:
        e.location ? cleanStr(e.location) :
        e.city ? cleanStr(e.city) :
        e.area ? cleanStr(e.area) :
        null,
      description: e.description ? cleanStr(e.description) : null,
      booking_url:
        isHttpUrl(e.booking_url) ? cleanStr(e.booking_url) :
        isHttpUrl(e.url) ? cleanStr(e.url) :
        null,
      day: typeof e.day === "number" ? e.day : toNumOrNull(e.day),
      price_per_person: toNumOrNull(e.price_per_person),
      currency: cleanStr(e.currency || "NOK") || "NOK",
    }))
    .slice(0, 20);
}

// ---------------------------
// Trip (hele)
// - Tåler både {trip:{...}} og flat {...}
// - Tåler json-string i feltene
// ---------------------------

export function normalizeTripV2(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const tripObj = (t.trip && typeof t.trip === "object") ? t.trip : null;

  const title = cleanStr(t.title || tripObj?.title) || "Reiseforslag";

  const descriptionRaw =
    t.description != null ? t.description :
    tripObj?.description != null ? tripObj.description :
    null;

  const description =
    typeof descriptionRaw === "string" ? cleanStr(descriptionRaw) : null;

  const stopsRaw = t.stops ?? tripObj?.stops ?? [];
  const packingRaw = t.packing_list ?? tripObj?.packing_list ?? [];
  const hotelsRaw = t.hotels ?? tripObj?.hotels ?? [];
  const expRaw = t.experiences ?? tripObj?.experiences ?? [];

  const stops = normalizeStopsV1toV2(stopsRaw);
  const packing_list = normalizePackingListV2(packingRaw);
  const hotels = normalizeHotelsV2(hotelsRaw);
  const experiences = normalizeExperiencesV2(expRaw);

  return {
    title,
    description: description || null,
    stops,
    packing_list,
    hotels,
    experiences,
  };
}
