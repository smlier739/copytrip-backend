// services/trips/episodeTrips.js (ESM)

import axios from "axios";
import { query } from "../db/query.js";
import { generateTripFromAI } from "../ai/tripGenerator.js"; // 👈 juster path
// import { generateGalleryForTrip } from "../gallery/galleryService.js"; // hvis du vil generere gallery her

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
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Ticket/booking fallback (IKKE Google Maps)
function makeTicketSearchUrl(title, location) {
  const t = String(title || "").trim();
  const loc = String(location || "").trim();
  if (!t) return null;
  const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
  return `https://www.google.com/search?q=${q}`;
}

const MAPBOX_TOKEN =
  process.env.MAPBOX_TOKEN ||
  process.env.MAPBOX_ACCESS_TOKEN ||
  process.env.MAPBOX_API_TOKEN ||
  null;

// Liten in-memory cache (per prosess) for å redusere Mapbox-kall
const geocodeCache = global.__geocodeCache || (global.__geocodeCache = new Map());

async function geocodePlaceMapbox(queryText) {
  if (!MAPBOX_TOKEN) return null;

  const q = String(queryText || "").trim();
  if (!q) return null;

  const key = q.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url =
    "https://api.mapbox.com/geocoding/v5/mapbox.places/" +
    encodeURIComponent(q) +
    ".json";

  try {
    const r = await axios.get(url, {
      params: { limit: 1, access_token: MAPBOX_TOKEN },
      timeout: 12000,
    });

    const f = r.data?.features?.[0];
    if (!f?.center || f.center.length < 2) {
      geocodeCache.set(key, null);
      return null;
    }

    const hit = { lng: f.center[0], lat: f.center[1] };
    geocodeCache.set(key, hit);
    return hit;
  } catch (e) {
    console.warn("[geocodePlaceMapbox] feilet:", e?.response?.status || "", e?.message || e);
    geocodeCache.set(key, null);
    return null;
  }
}

function normalizeExperience(x, fallbackLocation = null, fallbackOrder = null) {
  if (!x || typeof x !== "object") return null;

  const name =
    (typeof x.name === "string" && x.name.trim())
      ? x.name.trim()
      : (typeof x.title === "string" && x.title.trim())
      ? x.title.trim()
      : (typeof x.activity === "string" && x.activity.trim())
      ? x.activity.trim()
      : null;

  if (!name) return null;

  const location =
    (typeof x.location === "string" && x.location.trim())
      ? x.location.trim()
      : (typeof x.city === "string" && x.city.trim())
      ? x.city.trim()
      : (typeof x.area === "string" && x.area.trim())
      ? x.area.trim()
      : (fallbackLocation || null);

  const description =
    (typeof x.description === "string" && x.description.trim())
      ? x.description.trim()
      : null;

  const rawUrl =
    (typeof x.url === "string" && x.url.trim()) ? x.url.trim()
    : (typeof x.booking_url === "string" && x.booking_url.trim()) ? x.booking_url.trim()
    : (typeof x.ticket_url === "string" && x.ticket_url.trim()) ? x.ticket_url.trim()
    : (typeof x.link === "string" && x.link.trim()) ? x.link.trim()
    : (typeof x.external_url === "string" && x.external_url.trim()) ? x.external_url.trim()
    : null;

  const url = rawUrl
    ? (isHttpUrl(rawUrl) ? rawUrl : null)
    : makeTicketSearchUrl(name, location || "");

  const order = toNumOrNull(x.order) ?? toNumOrNull(x.day) ?? fallbackOrder ?? null;

  const price_per_person =
    (typeof x.price_per_person === "number")
      ? x.price_per_person
      : toNumOrNull(x.price_per_person);

  const currency =
    (typeof x.currency === "string" && x.currency.trim()) ? x.currency.trim() : "NOK";

  return {
    name,
    location,
    description,
    url,
    order,
    price_per_person: price_per_person ?? null,
    currency,
  };
}

// Én canonical per bruker per episode
export async function ensureTripForEpisode(episode, userId) {
  if (!episode?.id) throw new Error("ensureTripForEpisode: episode.id mangler");
  if (!userId) throw new Error("ensureTripForEpisode: userId mangler");

  // 0) Finn/gjenbruk canonical trip (nyeste) for denne brukeren
  const existing = await query(
    `
      SELECT id, created_at
      FROM trips
      WHERE source_episode_id = $1
        AND user_id = $2
        AND source_type = 'grenselos_episode'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [episode.id, userId]
  );

  if (existing.rowCount > 0) {
    console.log(
      "[ensureTripForEpisode] Gjenbruker system-trip (per bruker) for episode",
      episode.id,
      "trip_id =",
      existing.rows[0].id
    );
    return existing.rows[0].id;
  }

  // 1) Generer ny trip fra AI
  const ai = await generateTripFromAI({
    sourceUrl: episode.external_url,
    userDescription: `Lag en reise basert på Grenseløs-episoden: ${episode.name}`,
    userProfile: null,
  });

  const trip = (ai?.trip && typeof ai.trip === "object") ? ai.trip : {};

  let stops = parseArrayField(trip.stops);
  let packingList = parseArrayField(trip.packing_list);
  const tripLevelExperiences = parseArrayField(trip.experiences);

  // 2) Normaliser stops (order/day, lat/lng, sort)
  stops = stops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => {
      const order = toNumOrNull(s.order) ?? toNumOrNull(s.day) ?? (idx + 1);

      const name =
        (typeof s.name === "string" && s.name.trim())
          ? s.name.trim()
          : (typeof s.title === "string" && s.title.trim())
          ? s.title.trim()
          : `Stopp ${idx + 1}`;

      const location =
        (typeof s.location === "string" && s.location.trim()) ? s.location.trim()
        : (typeof s.address === "string" && s.address.trim()) ? s.address.trim()
        : null;

      const lat = toNumOrNull(s.lat ?? s.latitude ?? s?.geo?.lat);
      const lng = toNumOrNull(s.lng ?? s.lon ?? s.longitude ?? s?.geo?.lng);

      return {
        ...s,
        order,
        day: Math.max(1, Math.round(order)), // 👈 gjør eksplisitt day også
        name,
        location,
        lat: lat ?? null,
        lng: lng ?? null,
        hotels: parseArrayField(s.hotels),
        experiences: parseArrayField(s.experiences),
      };
    })
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));

  // 2b) Geokode manglende koordinater (valgfritt)
  if (MAPBOX_TOKEN) {
    for (const s of stops) {
      const has = typeof s.lat === "number" && Number.isFinite(s.lat) &&
                  typeof s.lng === "number" && Number.isFinite(s.lng);
      if (has) continue;

      const q = [s.name, s.location, trip.title].filter(Boolean).join(", ");
      const hit = await geocodePlaceMapbox(q);
      if (hit) {
        s.lat = hit.lat;
        s.lng = hit.lng;
      }
    }
  }

  // 3) Flat ut HOTELS fra stopp
  const defaultHotelPrice = 1200;
  const hotels = [];

  for (const s of stops) {
    for (const h of (s.hotels || [])) {
      if (!h || typeof h !== "object") continue;

      const name =
        (typeof h.name === "string" && h.name.trim()) ? h.name.trim()
        : (typeof h.title === "string" && h.title.trim()) ? h.title.trim()
        : "Hotell/overnatting";

      const price =
        toNumOrNull(h.approx_price_per_night ?? h.price_per_night) ?? defaultHotelPrice;

      const rawUrl =
        (typeof h.url === "string" && h.url.trim()) ? h.url.trim()
        : (typeof h.booking_url === "string" && h.booking_url.trim()) ? h.booking_url.trim()
        : (typeof h.link === "string" && h.link.trim()) ? h.link.trim()
        : (typeof h.external_url === "string" && h.external_url.trim()) ? h.external_url.trim()
        : null;

      const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

      hotels.push({
        name,
        location: s.name || null,
        description: (h.notes || h.description || null),
        price_per_night: price,
        url,
        order: s.order ?? null,
      });
    }
  }

  if (hotels.length === 0 && stops.length > 0) {
    const first = stops[0]?.name || "første stopp";
    hotels.push(
      {
        name: `Budsjett-hotell i ${first}`,
        location: first,
        description: "Forslag generert uten sikker lenke – velg etter beliggenhet og omtaler.",
        price_per_night: defaultHotelPrice,
        url: null,
        order: stops[0]?.order ?? 1,
      },
      {
        name: `Sentral overnatting i ${first}`,
        location: first,
        description: "Et alternativ nær sentrum/transport – sjekk tilgjengelighet i booking.",
        price_per_night: Math.round(defaultHotelPrice * 1.2),
        url: null,
        order: stops[0]?.order ?? 1,
      }
    );
  }

  // 4) Samle EXPERIENCES (trip + stopp)
  const experiences = [];

  for (const x of tripLevelExperiences) {
    const e = normalizeExperience(x, null, null);
    if (e) experiences.push(e);
  }

  for (const s of stops) {
    for (const x of (s.experiences || [])) {
      const e = normalizeExperience(x, s.name || null, s.order ?? null);
      if (e) experiences.push(e);
    }
  }

  if (experiences.length === 0) {
    const loc = stops[0]?.name || "";
    const ord = stops[0]?.order ?? 1;
    experiences.push(
      {
        name: "Guidet opplevelse / byvandring",
        location: loc || null,
        description: "Sjekk tilgjengelige turer og billetter i området.",
        url: makeTicketSearchUrl("Guidet tur", loc),
        order: ord,
        price_per_person: null,
        currency: "NOK",
      },
      {
        name: "Museum / attraksjon",
        location: loc || null,
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        url: makeTicketSearchUrl("Museum", loc),
        order: ord,
        price_per_person: null,
        currency: "NOK",
      }
    );
  }

  // Dedup experiences (name+location+order)
  const seenExp = new Set();
  const dedupedExperiences = [];
  for (const e of experiences) {
    const key = `${(e.name || "").toLowerCase()}|${(e.location || "").toLowerCase()}|${e.order ?? ""}`;
    if (seenExp.has(key)) continue;
    seenExp.add(key);
    dedupedExperiences.push(e);
  }

  // (Valgfritt) gallery: generer senere eller her
  const gallery = []; // evt: await generateGalleryForTrip(trip.title, trip.description, stops);

  // 5) INSERT (med DB-normalisering av stops)
  // Anbefalt: legg en unik constraint for å unngå race:
  // CREATE UNIQUE INDEX IF NOT EXISTS trips_unique_user_episode_canon
  //   ON trips(user_id, source_episode_id, source_type)
  //   WHERE source_type = 'grenselos_episode';
  //
  // Deretter kan du bruke ON CONFLICT ... DO UPDATE/NOTHING.
  const insert = await query(
    `
    INSERT INTO trips (
      user_id,
      title,
      description,
      stops,
      packing_list,
      hotels,
      experiences,
      source_type,
      source_episode_id,
      gallery,
      episode_url
    )
    VALUES (
      $1,
      $2,
      $3,
      COALESCE(
        (
          SELECT jsonb_agg(normalize_stop(e.stop, e.ord::int) ORDER BY e.ord)
          FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS e(stop, ord)
        ),
        '[]'::jsonb
      ),
      $5::jsonb,
      $6::jsonb,
      $7::jsonb,
      'grenselos_episode',
      $8,
      $9::jsonb,
      $10
    )
    RETURNING id
    `,
    [
      userId,
      (typeof trip.title === "string" && trip.title.trim()) ? trip.title.trim() : (episode.name || "Grenseløs-reise"),
      (typeof trip.description === "string" && trip.description.trim())
        ? trip.description.trim()
        : (episode.description || null),
      JSON.stringify(stops || []),
      JSON.stringify(packingList || []),
      JSON.stringify(hotels || []),
      JSON.stringify(dedupedExperiences || []),
      episode.id,
      JSON.stringify(gallery || []),
      episode.external_url || null,
    ]
  );

  const tripId = insert.rows?.[0]?.id;

  console.log(
    "[ensureTripForEpisode] Opprettet NY system-trip (per bruker) for episode",
    episode.id,
    "trip_id =",
    tripId,
    "stops:",
    (stops || []).length,
    "hotels:",
    (hotels || []).length,
    "experiences:",
    (dedupedExperiences || []).length
  );

  if (!tripId) {
    throw new Error("ensureTripForEpisode: INSERT returnerte ikke id");
  }

  return tripId;
}
