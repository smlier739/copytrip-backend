// routes/grenselos.js (ESM)

import express from "express";
import axios from "axios";

import authMiddleware from "../middleware/authMiddleware.js";

// TILPASS disse til dine faktiske paths/exports:
import { query } from "../db.js";
import { getSpotifyAccessToken } from "../services/spotify/spotifyClient.js";
import { generateTripFromEpisode } from "../services/ai/tripFromEpisode.js";
import { normalizePackingForClient } from "../services/packing/normalizePackingForClient.js";

const router = express.Router();

// ------------------------
// Helpers (flyttet ut)
// ------------------------
function parseJsonArray(value) {
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
}

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^https?:\/\/\S+/i.test(t);
}

function sanitizeUrl(s) {
  return isHttpUrl(s) ? s.trim() : null;
}

// Du sa tidligere: “bruk søk-fallback (ikke Maps) hvis ingen eksplisitt URL finnes”.
// Her har jeg beholdt din nåværende Maps-fallback i preview-ruten.
// Hvis du vil bytte til Booking-søk slik du hadde i makeHotelUrl(), si fra.
function makeHotelFallbackUrl(h) {
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(location ? `${name} ${location}` : name);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function makeExperienceFallbackUrl(x) {
  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(
    location ? `${name} ${location} billetter` : `${name} billetter`
  );
  return `https://www.google.com/search?q=${q}`;
}

// ---------------------------------------------
// GET /api/grenselos/episodes (Spotify, paging)
// ---------------------------------------------
router.get("/episodes", async (req, res) => {
  try {
    const showId = process.env.SPOTIFY_SHOW_ID;
    if (!showId) {
      return res.status(500).json({ error: "SPOTIFY_SHOW_ID er ikke satt i .env" });
    }

    const token = await getSpotifyAccessToken();

    const allItems = [];
    let nextUrl = `https://api.spotify.com/v1/shows/${showId}/episodes?market=NO&limit=50&offset=0`;

    // Spotify returnerer "next" som full URL. Vi følger den og sender IKKE params i tillegg.
    while (nextUrl) {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = response?.data || {};
      if (Array.isArray(data.items)) allItems.push(...data.items);

      nextUrl = data.next || null;
    }

    const episodes = allItems
      .map((ep) => ({
        id: ep.id,
        name: ep.name,
        description: ep.description,
        release_date: ep.release_date,
        audio_url: ep.audio_preview_url || null,
        external_url: ep.external_urls?.spotify || null,
        image: ep.images?.[0]?.url || null,
        duration_ms: ep.duration_ms
      }))
      // kronologisk (eldst -> nyest)
      .sort((a, b) => {
        if (!a.release_date || !b.release_date) return 0;
        return a.release_date.localeCompare(b.release_date);
      });

    return res.json({ episodes });
  } catch (err) {
    console.error(
      "[grenselos] Feil ved henting av Spotify-episoder:",
      err?.response?.data || err
    );
    return res.status(500).json({ error: "Kunne ikke hente episoder" });
  }
});

// ----------------------------------------------------------------------
// POST /api/grenselos/episodes/:id/analyze (preview, ikke lagre i DB)
// ----------------------------------------------------------------------
router.post("/episodes/:id/analyze", authMiddleware, async (req, res) => {
  try {
    const episodeId = (req.params.id || "").toString().trim();

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const userPreferences =
      typeof req.body?.userPreferences === "string"
        ? req.body.userPreferences.trim()
        : "";

    const useProfile = req.body?.useProfile !== false; // default true
    const episodeUrl =
      typeof req.body?.episode_url === "string" && req.body.episode_url.trim()
        ? req.body.episode_url.trim()
        : null;

    if (!episodeId) {
      return res.status(400).json({ error: "Mangler episode-id i URL." });
    }
    if (!name || !description) {
      return res.status(400).json({ error: "Mangler name eller description i request body." });
    }
    if (!req.user?.id) {
      return res.status(401).json({ error: "Ikke innlogget." });
    }

    // Premium/admin: detaljer kan vises (paywall på hoteller/pakkeliste/opplevelser)
    const detailsUnlocked = !!(req.user?.is_admin || req.user?.is_premium);

    // 1) Hent profil hvis ønsket
    let userProfile = null;
    if (useProfile) {
      try {
        const profRes = await query(
          `
          SELECT full_name, home_city, home_country, birth_year, travel_style, budget_per_day, experience_level
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [req.user.id]
        );
        userProfile = profRes.rows?.[0] || null;
      } catch (e) {
        console.warn("[grenselos/analyze] Kunne ikke hente profil (fortsetter uten):", e?.message || e);
        userProfile = null;
      }
    }

    // 2) Generer trip fra episode (IKKE lagre)
    const { trip: generatedTrip, raw } = await generateTripFromEpisode({
      episodeId,
      name,
      description,
      userPreferences,
      userProfile
    });

    const baseTrip =
      generatedTrip && typeof generatedTrip === "object"
        ? generatedTrip
        : {
            title: name || "Reise fra episode",
            description: null,
            stops: [],
            packing_list: [],
            hotels: [],
            experiences: [],
            gallery: []
          };

    // 3) Normaliser felter (klienten skal alltid få arrays + url fallbacks)
    const stops = parseJsonArray(baseTrip.stops);
    const gallery = parseJsonArray(baseTrip.gallery);

    const normalizedHotels = parseJsonArray(baseTrip.hotels)
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        ...h,
        url:
          sanitizeUrl(h?.url) ||
          sanitizeUrl(h?.booking_url) ||
          sanitizeUrl(h?.link) ||
          sanitizeUrl(h?.external_url) ||
          makeHotelFallbackUrl(h)
      }));

    const normalizedExperiences = parseJsonArray(baseTrip.experiences)
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        ...x,
        url:
          sanitizeUrl(x?.url) ||
          sanitizeUrl(x?.booking_url) ||
          sanitizeUrl(x?.ticket_url) ||
          sanitizeUrl(x?.link) ||
          sanitizeUrl(x?.external_url) ||
          makeExperienceFallbackUrl(x)
      }));

    const normalizedPacking = normalizePackingForClient(baseTrip.packing_list);

    // 4) Paywall detaljer
    const locked = !detailsUnlocked;

    const previewTrip = {
      ...baseTrip,

      // viktig: ingen "id" her siden den ikke er lagret
      id: undefined,

      title: baseTrip.title || name || "Reise fra episode",
      stops,
      gallery,

      source_type: "user_episode_trip_preview",
      source_episode_id: episodeId,
      episode_url: episodeUrl,

      hotels: locked ? [] : normalizedHotels,
      experiences: locked ? [] : normalizedExperiences,
      packing_list: locked ? [] : normalizedPacking,

      details_locked: locked,
      details_preview: locked
        ? {
            hotels_count: normalizedHotels.length,
            experiences_count: normalizedExperiences.length,
            packing_categories: (normalizedPacking || [])
              .map((g) => g?.category)
              .filter(Boolean)
              .slice(0, 6)
          }
        : null
    };

    return res.json({
      ok: true,
      trip: previewTrip,
      raw: raw || null,
      entitlement: {
        details_unlocked: detailsUnlocked,
        is_premium: !!req.user?.is_premium,
        is_admin: !!req.user?.is_admin
      }
    });
  } catch (err) {
    console.error("[grenselos] /episodes/:id/analyze (preview) feil:", err);
    return res.status(500).json({ error: "Kunne ikke analysere episoden." });
  }
});

export default router;
