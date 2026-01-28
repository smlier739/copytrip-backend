// backend/routes/trips.js (ESM)

import axios from "axios";
import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requirePro from "../middleware/requirePro.js";
import pool from "../db.js";

// Utils/services
import { parseJsonArray } from "../services/utils/json.js";
import { normalizePackingForClient } from "../services/packing/packingNormalize.js";

import { makeHotelUrl } from "../services/links/hotelLinks.js";
import { makeExperienceUrl } from "../services/links/experienceLinks.js";
import { sanitizeUrl } from "../services/utils/sanitizeUrl.js";

import { getUserEntitlements } from "../services/utils/entitlements.js";

// Trip services
import {
  generateGalleryForTrip,
  getGenericVirtualTripGallery,
} from "../services/gallery/galleryService.js";
import { inferCountryForTrip } from "../services/travelAdvice/inferCountryForTrip.js";
import { buildTravelAdviceText } from "../services/travelAdvice/buildTravelAdviceText.js";
import { extractDestinationFromStop1 } from "../services/trips/extractDestinationFromStop1.js";

const router = express.Router();

const TP_PLACES_URL = "https://autocomplete.travelpayouts.com/places2";

/* --------------------------------------------------
   TP Places: pick + resolve IATA
-------------------------------------------------- */

function pickBestPlace(places = []) {
  const arr = Array.isArray(places) ? places : [];
  if (!arr.length) return null;

  const city = arr.find(
    (p) => String(p?.type || "").toLowerCase() === "city" && p?.code
  );
  if (city) return city;

  const airport = arr.find(
    (p) => String(p?.type || "").toLowerCase() === "airport" && p?.code
  );
  if (airport) return airport;

  return arr.find((p) => p?.code) || null;
}

async function resolveIataFromPlaceName(placeName, locale = "no") {
  const term = String(placeName || "").trim();
  if (!term) return null;

  const r = await axios.get(TP_PLACES_URL, {
    params: { term, locale, "types[]": ["city", "airport"] },
    timeout: 12000,
  });

  const raw = Array.isArray(r.data) ? r.data : [];
  const picked = pickBestPlace(raw);
  const code = picked?.code ? String(picked.code).trim().toUpperCase() : null;
  return code || null;
}

/* --------------------------------------------------
   Persist iata into stops[0] on a specific trip row
   (secure: requires user_id match)
-------------------------------------------------- */

async function persistStop1Iata(tripId, userId, iata) {
  const code = String(iata || "").trim().toUpperCase();
  if (!code) return false;

  const r = await pool.query(
    `
    UPDATE trips
    SET stops = jsonb_set(
      COALESCE(stops, '[]'::jsonb),
      '{0,iata}',
      to_jsonb($3::text),
      true
    ),
    updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    `,
    [tripId, userId, code]
  );

  return r.rowCount > 0;
}

// For canonical system trip (no user_id constraint, but restricted to correct type/id)
async function persistCanonicalStop1Iata(canonicalTripId, iata) {
  const code = String(iata || "").trim().toUpperCase();
  if (!code) return false;

  const r = await pool.query(
    `
    UPDATE trips
    SET stops = jsonb_set(
      COALESCE(stops, '[]'::jsonb),
      '{0,iata}',
      to_jsonb($2::text),
      true
    ),
    updated_at = NOW()
    WHERE id = $1 AND source_type = 'grenselos_episode'
    `,
    [canonicalTripId, code]
  );

  return r.rowCount > 0;
}

/* --------------------------------------------------
   Helpers: stops normalization + destination
-------------------------------------------------- */

function normalizeStops(stopsRaw) {
  const arr = Array.isArray(stopsRaw) ? stopsRaw : parseJsonArray(stopsRaw);

  return (arr || [])
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const iata =
        (s.iata ||
          s.code ||
          s.airport_iata ||
          s.airportIata ||
          s.iata_code ||
          "")
          .toString()
          .trim()
          .toUpperCase() || null;

      const name =
        (s.name ||
          s.city ||
          s.place ||
          s.location ||
          s.title ||
          s.label ||
          s.destinationName ||
          "")
          .toString()
          .trim() || null;

      const country =
        (s.country || s.country_name || s.countryName || "")
          .toString()
          .trim() || null;

      return { ...s, iata, name, country };
    });
}

function pickDestinationFromStops(stopsNorm) {
  const s0 = Array.isArray(stopsNorm) ? stopsNorm[0] : null;
  if (!s0) return null;
  return { name: s0.name || null, country: s0.country || null, iata: s0.iata || null };
}

function buildPlaceNameForIataLookup(destination, stopsNorm) {
  const s0 = Array.isArray(stopsNorm) ? stopsNorm[0] : null;
  const name =
    String(destination?.name || "").trim() ||
    String(s0?.name || "").trim() ||
    String(s0?.city || "").trim() ||
    String(s0?.location || "").trim() ||
    "";

  const country = String(destination?.country || s0?.country || "").trim();

  // Prefer "Name, Country" if we have both
  if (name && country && !name.toLowerCase().includes(country.toLowerCase())) {
    return `${name}, ${country}`;
  }
  return name || "";
}

/**
 * Ensure destination has iata. If missing:
 * - resolve via TP autocomplete
 * - persist into user-trip stops[0]
 * - if episode-trip and we know canonicalTripId, persist there too
 */
async function ensureDestinationIata({
  userTripId,
  userId,
  destination,
  stopsNorm,
  canonicalTripId = null,
  locale = "no",
}) {
  if (destination?.iata) return destination;

  const placeName = buildPlaceNameForIataLookup(destination, stopsNorm);
  if (!placeName) return destination;

  const resolvedIata = await resolveIataFromPlaceName(placeName, locale);
  if (!resolvedIata) return destination;

  // persist on user trip
  await persistStop1Iata(userTripId, userId, resolvedIata);

  // persist on canonical trip if relevant
  if (canonicalTripId) {
    await persistCanonicalStop1Iata(canonicalTripId, resolvedIata);
  }

  return { ...(destination || {}), iata: resolvedIata };
}

/* --------------------------------------------------
   GET /api/trips/:id/packing-list (Pro)
-------------------------------------------------- */

router.get("/:id/packing-list", authMiddleware, requirePro, async (req, res) => {
  try {
    const tripId = req.params.id;
    const userId = req.user.id;

    const tripRes = await pool.query(
      `
      SELECT id, source_episode_id, packing_list
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, userId]
    );

    if (!tripRes.rows.length) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let packing = row.packing_list;

    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT packing_list
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) packing = canonRes.rows[0].packing_list;
    }

    const packingFull = normalizePackingForClient(packing);
    return res.json({ ok: true, tripId, packing_list: packingFull });
  } catch (e) {
    console.error("GET /api/trips/:id/packing-list feilet:", e);
    return res.status(500).json({ error: "Kunne ikke hente pakkeliste." });
  }
});

/* --------------------------------------------------
   GET /api/trips/:id/experiences
-------------------------------------------------- */

router.get("/:id/experiences", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;
    const userId = req.user.id;

    const ent = await getUserEntitlements(userId);
    const isPro = !!ent?.isPro;

    const tripRes = await pool.query(
      `
      SELECT id, source_episode_id, experiences
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, userId]
    );

    if (!tripRes.rows.length) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let experiences = parseJsonArray(row.experiences);

    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT experiences
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) experiences = parseJsonArray(canonRes.rows[0].experiences);
    }

    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

    const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
      name: x?.name || x?.title || "Opplevelse",
      location: x?.location || x?.city || x?.area || null,
      description: x?.description || null,
    }));

    return res.json({
      ok: true,
      tripId,
      experiences: isPro ? experiencesFull : experiencesPreview,
      entitlements: { isPro, locked: { experiences: !isPro } },
      counts: { experiences: experiencesFull.length },
    });
  } catch (e) {
    console.error("GET /api/trips/:id/experiences feilet:", e);
    return res.status(500).json({ error: "Kunne ikke hente opplevelser." });
  }
});

/* --------------------------------------------------
   POST /api/trips
-------------------------------------------------- */

router.post("/", authMiddleware, async (req, res) => {
  try {
    let {
      title,
      description,
      stops,
      packing_list,
      hotels,
      gallery,
      source_type,
      source_episode_id,
      episode_url,
      experiences,
    } = req.body ?? {};

    const parseArrayField = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Mangler title i request body." });
    }
    title = String(title).trim();

    let finalStops = parseArrayField(stops);
    let finalPacking = parseArrayField(packing_list);
    let finalHotels = parseArrayField(hotels);
    let finalGallery = parseArrayField(gallery);
    let finalExperiences = parseArrayField(experiences);

    let sourceType = source_type || null;

    if (source_episode_id) {
      sourceType = "user_episode_trip";

      const sysRes = await pool.query(
        `
        SELECT stops, packing_list, hotels, gallery, experiences
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [source_episode_id]
      );

      if (sysRes.rowCount > 0) {
        const sys = sysRes.rows[0];

        if (!Array.isArray(finalStops) || !finalStops.length) finalStops = parseArrayField(sys.stops);
        if (!Array.isArray(finalPacking) || !finalPacking.length) finalPacking = parseArrayField(sys.packing_list);
        if (!Array.isArray(finalHotels) || !finalHotels.length) finalHotels = parseArrayField(sys.hotels);

        if (!Array.isArray(finalGallery) || !finalGallery.length) {
          const g = parseArrayField(sys.gallery);
          if (g.length) finalGallery = g;
        }

        if (!Array.isArray(finalExperiences) || !finalExperiences.length) {
          finalExperiences = parseArrayField(sys.experiences);
        }
      }

      if (!Array.isArray(finalStops) || !finalStops.length) {
        return res.status(400).json({
          error: "Episode-reise mangler stops. Fant heller ingen system-trip å kopiere stops fra.",
        });
      }
    } else {
      if (!Array.isArray(finalStops) || !finalStops.length) {
        return res.status(400).json({ error: "Mangler stops (array) i request body." });
      }

      if (!Array.isArray(finalGallery) || !finalGallery.length) {
        finalGallery = await generateGalleryForTrip(title, description, finalStops);
      }
    }

    // URL sanitize/fallback
    finalHotels = (finalHotels || []).map((h) => {
      const direct =
        sanitizeUrl(h?.url) ||
        sanitizeUrl(h?.booking_url) ||
        sanitizeUrl(h?.link) ||
        sanitizeUrl(h?.external_url);

      return { ...h, url: direct || makeHotelUrl(h) };
    });

    finalExperiences = (finalExperiences || []).map((x) => ({
      ...x,
      url:
        sanitizeUrl(x?.url) ||
        sanitizeUrl(x?.booking_url) ||
        sanitizeUrl(x?.ticket_url) ||
        sanitizeUrl(x?.link) ||
        sanitizeUrl(x?.external_url) ||
        makeExperienceUrl(x),
    }));

    const insert = await pool.query(
      `
      INSERT INTO trips (
        user_id,
        title,
        description,
        stops,
        packing_list,
        hotels,
        source_type,
        source_episode_id,
        gallery,
        episode_url,
        experiences
      )
      VALUES (
        $1,$2,$3,
        COALESCE(
          (
            SELECT jsonb_agg(normalize_stop(e.stop, e.ord::int) ORDER BY e.ord)
            FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS e(stop, ord)
          ),
          '[]'::jsonb
        ),
        $5::jsonb,
        $6::jsonb,
        $7,
        $8,
        $9::jsonb,
        $10,
        $11::jsonb
      )
      RETURNING *
      `,
      [
        req.user.id,
        title,
        description ? String(description) : null,
        JSON.stringify(finalStops || []),
        JSON.stringify(finalPacking || []),
        JSON.stringify(finalHotels || []),
        sourceType,
        source_episode_id || null,
        JSON.stringify(finalGallery || []),
        episode_url || null,
        JSON.stringify(finalExperiences || []),
      ]
    );

    const row = insert.rows[0];
    const stopsNorm = normalizeStops(row.stops);
    const destination = pickDestinationFromStops(stopsNorm);

    return res.status(201).json({
      ok: true,
      trip: {
        ...row,
        stops: stopsNorm,
        destination,
        packing_list: parseJsonArray(row.packing_list),
        hotels: parseJsonArray(row.hotels),
        gallery: parseJsonArray(row.gallery),
        experiences: parseJsonArray(row.experiences),
      },
    });
  } catch (e) {
    console.error("POST /api/trips feilet:", e);
    return res.status(500).json({ error: "Kunne ikke opprette reise." });
  }
});

/* --------------------------------------------------
   GET /api/trips/:id
   Canonical override + entitlements gating + destination (with IATA ensure)
-------------------------------------------------- */

router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;
    const userId = req.user.id;

    const ent = await getUserEntitlements(userId);
    const isPro = !!ent?.isPro;

    const tripRes = await pool.query(
      `
      SELECT
        id,
        user_id,
        title,
        description,
        stops,
        gallery,
        hotels,
        packing_list,
        experiences,
        source_type,
        source_episode_id,
        episode_url,
        created_at,
        updated_at
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, userId]
    );

    if (!tripRes.rows.length) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    let stops = parseJsonArray(row.stops);
    let gallery = parseJsonArray(row.gallery);
    let hotels = parseJsonArray(row.hotels);
    let experiences = parseJsonArray(row.experiences);
    let packing = row.packing_list;

    let canonicalTripId = null;

    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT id, gallery, hotels, packing_list, experiences, stops
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );

      const c = canonRes.rows?.[0] || null;
      if (c) {
        canonicalTripId = c.id;

        const canonStops = parseJsonArray(c.stops);
        if (canonStops.length) stops = canonStops;

        gallery = parseJsonArray(c.gallery);
        hotels = parseJsonArray(c.hotels);
        experiences = parseJsonArray(c.experiences);
        packing = c.packing_list;
      }
    }

    const stopsNorm = normalizeStops(stops);

    let destination =
      pickDestinationFromStops(stopsNorm) ||
      (typeof extractDestinationFromStop1 === "function"
        ? extractDestinationFromStop1(stopsNorm)
        : null);

    destination = await ensureDestinationIata({
      userTripId: row.id,
      userId,
      destination,
      stopsNorm,
      canonicalTripId,
      locale: "no",
    });

    const hotelsFull = (hotels || [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({ ...h, url: makeHotelUrl(h) }));

    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

    const packingFull = normalizePackingForClient(packing);

    const hotelsPreview = hotelsFull.slice(0, 3).map((h) => ({
      name: h?.name || h?.title || "Hotell",
      location: h?.location || h?.city || h?.area || null,
    }));

    const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
      name: x?.name || x?.title || "Opplevelse",
      location: x?.location || x?.city || x?.area || null,
      description: x?.description || null,
    }));

    const packingPreview = Array.isArray(packingFull) ? packingFull.slice(0, 6) : [];

    const locked = { hotels: !isPro, experiences: !isPro, packing_list: !isPro };

    return res.json({
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      description: row.description,
      source_type: row.source_type,
      source_episode_id: row.source_episode_id,
      episode_url: row.episode_url,
      created_at: row.created_at,
      updated_at: row.updated_at,

      stops: stopsNorm,
      destination,
      gallery,

      hotels: isPro ? hotelsFull : hotelsPreview,
      experiences: isPro ? experiencesFull : experiencesPreview,
      packing_list: isPro ? packingFull : packingPreview,

      entitlements: { isPro, locked },
      counts: {
        hotels: hotelsFull.length,
        experiences: experiencesFull.length,
        packing_list: Array.isArray(packingFull) ? packingFull.length : 0,
        stops: stopsNorm.length,
        gallery: Array.isArray(gallery) ? gallery.length : 0,
      },
    });
  } catch (err) {
    console.error("GET /api/trips/:id feilet:", err);
    return res.status(500).json({ error: "Kunne ikke hente reisen." });
  }
});

/* --------------------------------------------------
   GET /api/trips/:id/hotels
   Returns destination (incl iata) + entitlements gating
-------------------------------------------------- */

router.get("/:id/hotels", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;
    const userId = req.user.id;

    const ent = await getUserEntitlements(userId);
    const isPro = !!ent?.isPro;

    const tripRes = await pool.query(
      `
      SELECT id, user_id, title, stops, hotels, source_type, source_episode_id, episode_url
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, userId]
    );

    if (!tripRes.rows.length) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    let stops = parseJsonArray(row.stops);
    let hotels = parseJsonArray(row.hotels);

    let canonicalTripId = null;

    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT id, hotels, stops
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );

      if (canonRes.rows?.[0]) {
        canonicalTripId = canonRes.rows[0].id;

        hotels = parseJsonArray(canonRes.rows[0].hotels);
        const canonStops = parseJsonArray(canonRes.rows[0].stops);
        if (canonStops.length) stops = canonStops;
      }
    }

    const stopsNorm = normalizeStops(stops);

    let destination =
      pickDestinationFromStops(stopsNorm) ||
      (typeof extractDestinationFromStop1 === "function"
        ? extractDestinationFromStop1(stopsNorm)
        : null);

    destination = await ensureDestinationIata({
      userTripId: row.id,
      userId,
      destination,
      stopsNorm,
      canonicalTripId,
      locale: "no",
    });

    const hotelsFull = (hotels || [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        ...h,
        url: isPro ? makeHotelUrl(h) : undefined,
      }));

    const hotelsPreview = hotelsFull.slice(0, 10).map((h) => ({
      name: h?.name || h?.title || "Hotell",
      location: h?.location || h?.city || h?.area || null,
    }));

    return res.json({
      ok: true,
      tripId,
      destination,
      hotels: isPro ? hotelsFull : hotelsPreview,
      entitlements: { isPro, locked: { hotels: !isPro } },
      counts: { hotels: hotelsFull.length },
      source: {
        source_type: row.source_type || null,
        source_episode_id: row.source_episode_id || null,
        episode_url: row.episode_url || null,
      },
    });
  } catch (e) {
    console.error("GET /api/trips/:id/hotels feilet:", e);
    return res.status(500).json({ error: "Kunne ikke hente hoteller." });
  }
});

/* --------------------------------------------------
   GET /api/trips/:id/travel-advice
-------------------------------------------------- */

router.get("/:id/travel-advice", authMiddleware, async (req, res) => {
  try {
    const tripId = String(req.params.id || "").trim();
    if (!tripId) return res.status(400).json({ error: "Mangler trip-id i URL." });

    const tripRes = await pool.query(
      `
      SELECT id, title, description, stops
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, req.user.id]
    );

    if (!tripRes.rows?.length) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const trip = tripRes.rows[0];
    const tripNormalized = { ...trip, stops: normalizeStops(trip.stops) };

    let country = null;
    try {
      country = await inferCountryForTrip(tripNormalized);
    } catch (err) {
      console.warn("inferCountryForTrip feilet (fortsetter):", err?.message || err);
      country = null;
    }

    let advice = "";
    try {
      advice = await buildTravelAdviceText(country || "generelt");
    } catch (err) {
      console.warn("buildTravelAdviceText feilet (fallback):", err?.message || err);
      advice =
        "Generelle reiseråd: Sjekk pass/visumregler, reiseforsikring, lokale lover og skikker, helse/anbefalte vaksiner, og oppdaterte reiseråd fra UD. Ha digitale og fysiske kopier av viktige dokumenter, og lag en plan for betaling og nødnummer.";
    }

    return res.json({ ok: true, tripId, country: country || null, advice: advice || "" });
  } catch (e) {
    console.error("GET /api/trips/:id/travel-advice feilet:", e);
    return res.status(500).json({ error: "Kunne ikke hente reiseråd." });
  }
});

/* --------------------------------------------------
   POST /api/trips/:id/delete
-------------------------------------------------- */

router.post("/:id/delete", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;
    const userId = req.user.id;

    const checkRes = await pool.query(
      `
      SELECT id, source_type
      FROM trips
      WHERE id = $1 AND user_id = $2
      `,
      [tripId, userId]
    );

    if (!checkRes.rowCount) {
      return res.status(404).json({ error: "Reise ikke funnet." });
    }

    const trip = checkRes.rows[0];

    if (trip.source_type === "grenselos_episode") {
      return res.status(403).json({
        error:
          "Denne reisen er en systemreise for Grenseløs-episoder og kan ikke slettes, fordi den også inneholder galleribilder brukt i Admin.",
      });
    }

    const result = await pool.query(
      `DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING id`,
      [tripId, userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Reise ikke funnet." });
    }

    return res.json({ success: true, deletedId: tripId });
  } catch (e) {
    console.error("POST /api/trips/:id/delete feilet:", e);
    return res.status(500).json({ error: "Kunne ikke slette reise." });
  }
});

/* --------------------------------------------------
   GET /api/trips
   List user trips
   NOTE: No async IATA resolving here (avoid N+1 network calls)
-------------------------------------------------- */

router.get("/", authMiddleware, async (req, res) => {
  try {
    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    const baseRes = await pool.query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
        AND (
          source_type IS NULL
          OR source_type = 'template'
          OR source_type = 'user_episode_trip'
        )
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const rows = baseRes.rows || [];

    const episodeIds = [
      ...new Set(
        rows
          .map((r) => r.source_episode_id)
          .filter((id) => typeof id === "string" && id.trim() !== "")
      ),
    ];

    let canonicalByEpisodeId = {};
    if (episodeIds.length > 0) {
      const canonRes = await pool.query(
        `
        SELECT
          source_episode_id,
          gallery,
          hotels,
          packing_list,
          experiences,
          stops,
          created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = ANY($1)
        ORDER BY source_episode_id ASC, created_at DESC
        `,
        [episodeIds]
      );

      canonicalByEpisodeId = canonRes.rows.reduce((acc, row) => {
        const epId = row.source_episode_id;
        if (!epId) return acc;
        if (!acc[epId]) {
          acc[epId] = {
            gallery: parseJsonArray(row.gallery),
            hotels: parseJsonArray(row.hotels),
            packing_list: row.packing_list,
            experiences: parseJsonArray(row.experiences),
            stops: parseJsonArray(row.stops),
          };
        }
        return acc;
      }, {});
    }

    const trips = rows.map((row) => {
      let stops = parseJsonArray(row.stops);

      let gallery = parseJsonArray(row.gallery);
      let hotels = parseJsonArray(row.hotels);
      let packing = row.packing_list;
      let experiences = parseJsonArray(row.experiences);

      const episodeId = row.source_episode_id;

      if (episodeId && canonicalByEpisodeId[episodeId]) {
        const canon = canonicalByEpisodeId[episodeId];
        stops = canon.stops;
        gallery = canon.gallery;
        hotels = canon.hotels;
        packing = canon.packing_list;
        experiences = canon.experiences;
      } else {
        if (!Array.isArray(gallery) || gallery.length === 0) {
          gallery = getGenericVirtualTripGallery(3);
        }
      }

      const stopsNorm = normalizeStops(stops);

      // Best-effort destination (NO network resolving here)
      const destination =
        pickDestinationFromStops(stopsNorm) ||
        (typeof extractDestinationFromStop1 === "function"
          ? extractDestinationFromStop1(stopsNorm)
          : null);

      const hotelsFull = (hotels || [])
        .filter((h) => h && typeof h === "object")
        .map((h) => ({ ...h, url: makeHotelUrl(h) }));

      const experiencesFull = (experiences || [])
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

      const packingFull = normalizePackingForClient(packing);

      const hotelsPreview = hotelsFull.slice(0, 3).map((h) => ({
        name: h?.name || h?.title || "Hotell",
        location: h?.location || h?.city || h?.area || null,
      }));

      const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
        name: x?.name || x?.title || "Opplevelse",
        location: x?.location || x?.city || x?.area || null,
      }));

      const packingPreview = Array.isArray(packingFull) ? packingFull.slice(0, 6) : [];

      const locked = { hotels: !isPro, experiences: !isPro, packing_list: !isPro };

      return {
        ...row,
        stops: stopsNorm,
        destination,
        gallery,

        hotels: isPro ? hotelsFull : hotelsPreview,
        experiences: isPro ? experiencesFull : experiencesPreview,
        packing_list: isPro ? packingFull : packingPreview,

        entitlements: { isPro, locked },
        counts: {
          hotels: hotelsFull.length,
          experiences: experiencesFull.length,
          packing_list: Array.isArray(packingFull) ? packingFull.length : 0,
        },
      };
    });

    return res.json({ trips });
  } catch (err) {
    console.error("GET /api/trips feilet:", err);
    return res.status(500).json({ error: "Kunne ikke hente reiser." });
  }
});

export default router;
