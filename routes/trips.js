// backend/routes/trips.js (ESM)
import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requirePro from "../middleware/requirePro.js";
import pool from "../db.js";

// Utils/services (tilpass paths hvis dine ligger andre steder)
import { parseJsonArray } from "../utils/json.js";
import { normalizePackingForClient } from "../services/packing/packingNormalize.js";

import { makeHotelUrl } from "../services/links/hotelLinks.js";
import { makeExperienceUrl } from "../services/links/experienceLinks.js";
import { sanitizeUrl } from "../services/util/sanitizeUrl.js";

// Entitlements (må finnes; hvis du har annet navn, bytt importen)
import { getUserEntitlements } from "../services/entitlements.js";

// Trip services (tilpass hvis du har dem andre steder)
import { generateGalleryForTrip } from "../services/gallery/generateGalleryForTrip.js";
import { inferCountryForTrip } from "../services/travelAdvice/inferCountryForTrip.js";
import { buildTravelAdviceText } from "../services/travelAdvice/buildTravelAdviceText.js";
import { extractDestinationFromStop1 } from "../services/trips/extractDestinationFromStop1.js";
import { getGenericVirtualTripGallery } from "../services/gallery/genericVirtualTripGallery.js";

const router = express.Router();

/**
 * GET /api/trips/:id/packing-list  (mounted as /:id/packing-list)
 * Pro-only, med canonical override hvis episode-trip
 */
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

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let packing = row.packing_list;

    // episode-trip: canonical packing_list fra system-trip
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

/**
 * GET /api/trips/:id/experiences (mounted as /:id/experiences)
 * - Gratis: preview (3 første uten url)
 * - Pro: full liste med url
 */
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

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let experiences = parseJsonArray(row.experiences);

    // episode-trip: canonical experiences
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
      if (canonRes.rows?.[0]) {
        experiences = parseJsonArray(canonRes.rows[0].experiences);
      }
    }

    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

    const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
      name: x?.name || x?.title || "Opplevelse",
      location: x?.location || x?.city || x?.area || null,
      description: x?.description || null,
      // url utelates i preview
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

/**
 * POST /api/trips (mounted as /)
 * Opprett reise
 */
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

    // --- valider title ---
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Mangler title i request body." });
    }
    title = String(title).trim();

    // --- input parsing ---
    let finalStops = parseArrayField(stops);
    let finalPacking = parseArrayField(packing_list);
    let finalHotels = parseArrayField(hotels);
    let finalGallery = parseArrayField(gallery);
    let finalExperiences = parseArrayField(experiences);

    // --- episode basert: copy canonical hvis klient mangler felt ---
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

        // hvis klienten mangler stops → bruk system
        if (!Array.isArray(finalStops) || finalStops.length === 0) {
          finalStops = parseArrayField(sys.stops);
        }
        if (!Array.isArray(finalPacking) || finalPacking.length === 0) {
          finalPacking = parseArrayField(sys.packing_list);
        }
        if (!Array.isArray(finalHotels) || finalHotels.length === 0) {
          finalHotels = parseArrayField(sys.hotels);
        }
        if (!Array.isArray(finalGallery) || finalGallery.length === 0) {
          const g = parseArrayField(sys.gallery);
          if (g.length) finalGallery = g;
        }
        if (!Array.isArray(finalExperiences) || finalExperiences.length === 0) {
          finalExperiences = parseArrayField(sys.experiences);
        }
      }

      if (!Array.isArray(finalStops) || finalStops.length === 0) {
        return res.status(400).json({
          error:
            "Episode-reise mangler stops. Fant heller ingen system-trip å kopiere stops fra.",
        });
      }
    } else {
      // ikke-episode: må ha stops
      if (!Array.isArray(finalStops) || finalStops.length === 0) {
        return res.status(400).json({ error: "Mangler stops (array) i request body." });
      }

      // generer galleri hvis tomt
      if (!Array.isArray(finalGallery) || finalGallery.length === 0) {
        finalGallery = await generateGalleryForTrip(title, description, finalStops);
      }
    }

    // --- URL sanitize/fallback ---
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

    // --- lagre i DB (DB normaliserer stops via normalize_stop) ---
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

    return res.status(201).json({
      ok: true,
      trip: {
        ...row,
        stops: Array.isArray(row.stops) ? row.stops : parseJsonArray(row.stops),
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

/**
 * GET /api/trips/:id (mounted as /:id)
 * Canonical override + entitlements gating
 */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
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
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    let stops = parseJsonArray(row.stops);
    let gallery = parseJsonArray(row.gallery);
    let hotels = parseJsonArray(row.hotels);
    let experiences = parseJsonArray(row.experiences);
    let packing = row.packing_list;

    // canonical override for episode
    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT gallery, hotels, packing_list, experiences, stops
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
        const canonStops = parseJsonArray(c.stops);
        if (canonStops.length) stops = canonStops;

        gallery = parseJsonArray(c.gallery);
        hotels = parseJsonArray(c.hotels);
        experiences = parseJsonArray(c.experiences);
        packing = c.packing_list;
      }
    }

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

    const locked = {
      hotels: !isPro,
      experiences: !isPro,
      packing_list: !isPro,
    };

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

      stops,
      gallery,

      hotels: isPro ? hotelsFull : hotelsPreview,
      experiences: isPro ? experiencesFull : experiencesPreview,
      packing_list: isPro ? packingFull : packingPreview,

      entitlements: { isPro, locked },
      counts: {
        hotels: hotelsFull.length,
        experiences: experiencesFull.length,
        packing_list: Array.isArray(packingFull) ? packingFull.length : 0,
        stops: stops.length,
        gallery: gallery.length,
      },
    });
  } catch (err) {
    console.error("GET /api/trips/:id feilet:", err);
    return res.status(500).json({ error: "Kunne ikke hente reisen." });
  }
});

/**
 * GET /api/trips/:id/hotels (mounted as /:id/hotels)
 */
router.get("/:id/hotels", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    const tripRes = await pool.query(
      `
      SELECT id, user_id, title, stops, hotels, source_type, source_episode_id, episode_url
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let hotels = parseJsonArray(row.hotels);

    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT hotels
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) hotels = parseJsonArray(canonRes.rows[0].hotels);
    }

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

    const destination = extractDestinationFromStop1(row.stops);

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

/**
 * GET /api/trips/:id/travel-advice (mounted as /:id/travel-advice)
 */
router.get("/:id/travel-advice", authMiddleware, async (req, res) => {
  try {
    const tripId = (req.params.id || "").toString().trim();
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
    const tripNormalized = { ...trip, stops: parseJsonArray(trip.stops) };

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

/**
 * POST /api/trips/:id/delete (mounted as /:id/delete)
 */
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

    if (checkRes.rowCount === 0) {
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

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reise ikke funnet." });
    }

    return res.json({ success: true, deletedId: tripId });
  } catch (e) {
    console.error("POST /api/trips/:id/delete feilet:", e);
    return res.status(500).json({ error: "Kunne ikke slette reise." });
  }
});

/**
 * GET /api/trips (mounted as /)
 * Liste over brukerreiser (med canonical override for episode-trips)
 */
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
          };
        }
        return acc;
      }, {});
    }

    const trips = rows.map((row) => {
      const stops = parseJsonArray(row.stops);

      let gallery = parseJsonArray(row.gallery);
      let hotels = parseJsonArray(row.hotels);
      let packing = row.packing_list;
      let experiences = parseJsonArray(row.experiences);

      const episodeId = row.source_episode_id;

      if (episodeId && canonicalByEpisodeId[episodeId]) {
        const canon = canonicalByEpisodeId[episodeId];
        gallery = parseJsonArray(canon.gallery);
        hotels = parseJsonArray(canon.hotels);
        packing = canon.packing_list;
        experiences = parseJsonArray(canon.experiences);
      } else {
        if (!Array.isArray(gallery) || gallery.length === 0) {
          gallery = getGenericVirtualTripGallery(3);
        }
      }

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

      const locked = {
        hotels: !isPro,
        experiences: !isPro,
        packing_list: !isPro,
      };

      return {
        ...row,
        stops,
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
