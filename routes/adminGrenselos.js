// backend/routes/adminGrenselos.js (ESM)

import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";

import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import pool from "../db.js";

import { fetchGrenselosEpisodes } from "../services/spotify/fetchGrenselosEpisodes.js";
import { ensureTripForEpisode } from "../services/trips/episodeTrips.js";

// Viktig: bruk samme uploadDir som appen server via /uploads
import { uploadDir } from "../services/uploads/communityUploads.js";

const router = express.Router();

// ---------------------------------------------------------
// Galleri-root under samme uploadDir som serveres via /uploads
// /uploads -> uploadDir
// /uploads/grenselos-gallery/... -> uploadDir/grenselos-gallery/...
// ---------------------------------------------------------
const GALLERY_ROOT = path.join(uploadDir, "grenselos-gallery");

if (!fs.existsSync(GALLERY_ROOT)) {
  fs.mkdirSync(GALLERY_ROOT, { recursive: true });
}

function safeSegment(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
}

function parseJsonArray(value) {
  // gallery er jsonb i DB, men vi tåler både string/object
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value; // jsonb kan komme som objekt/array allerede
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

// ---------------------------------------------------------
// Kontinent-grouping (deterministisk)
// NB: Dette er en enkel heuristikk basert på tittel/beskrivelse.
// Du kan senere gjøre dette "riktig" via egen episode-metadata-tabell.
// ---------------------------------------------------------
const CONTINENT_ORDER = ["Europe", "America", "Asia", "Africa", "Oceania", "Other"];

function normalizeName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function sortEpisodesStable(a, b) {
  // Stabil, deterministisk sort for å unngå "vilkårlig" rekkefølge
  const byName = normalizeName(a?.name).localeCompare(normalizeName(b?.name), "nb");
  if (byName !== 0) return byName;

  const byDate = String(b?.release_date || "").localeCompare(String(a?.release_date || ""));
  if (byDate !== 0) return byDate;

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function guessContinent(ep) {
  const hay = `${ep?.name || ""} ${ep?.description || ""}`.toLowerCase();

  // Europe (inkl. Norge/Europa-byer/land)
  if (
    /(norge|norway|oslo|bergen|trondheim|stavanger|sverige|sweden|danmark|denmark|finland|island|uk|england|scotland|ireland|frankrike|france|paris|spain|madrid|italy|roma|tyskland|germany|berlin|polen|poland|portugal|lisboa|hellas|greece|athen|praha|vienna|østerrike|austria|københavn|copenhagen|stockholm)/i.test(
      hay
    )
  )
    return "Europe";

  // America (Nord+Sør)
  if (
    /(usa|united states|new york|los angeles|california|texas|miami|canada|toronto|vancouver|mexico|brazil|brasil|argentina|peru|chile|colombia|cuba|patagonia)/i.test(
      hay
    )
  )
    return "America";

  // Asia
  if (
    /(japan|tokyo|kina|china|beijing|shanghai|thailand|bangkok|vietnam|hanoi|saigon|india|delhi|nepal|kathmandu|indonesia|bali|philippines|manila|singapore|korea|seoul|sri lanka|pakistan)/i.test(
      hay
    )
  )
    return "Asia";

  // Africa
  if (
    /(afrika|africa|marokko|morocco|egypt|cairo|tanzania|zanzibar|kenya|nairobi|south africa|cape town|tunisia|algeria|ethiopia|uganda|rwanda)/i.test(
      hay
    )
  )
    return "Africa";

  // Oceania
  if (
    /(australia|sydney|melbourne|new zealand|nz|auckland|oceania|polynesia|fiji|tahiti|samoa)/i.test(
      hay
    )
  )
    return "Oceania";

  return "Other";
}

function groupEpisodesByContinent(episodes) {
  const temp = {};
  for (const ep of episodes || []) {
    const c = guessContinent(ep);
    if (!temp[c]) temp[c] = [];
    temp[c].push(ep);
  }

  // Sortér inni grupper deterministisk
  for (const k of Object.keys(temp)) temp[k].sort(sortEpisodesStable);

  // Stabil nøkkelrekkefølge
  const out = {};
  for (const k of CONTINENT_ORDER) if (temp[k]?.length) out[k] = temp[k];

  // Eventuelle ukjente keys (skal normalt ikke skje)
  const extras = Object.keys(temp)
    .filter((k) => !CONTINENT_ORDER.includes(k))
    .sort();
  for (const k of extras) out[k] = temp[k];

  return out;
}

// ---------------------------------------------------------
// Multer storage
// ---------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const episodeId = safeSegment(req.params.episodeId);
    const dest = path.join(GALLERY_ROOT, episodeId);
    try {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const original = file.originalname || "image";
    const safeName = original.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

// Kun bilder
function fileFilter(_req, file, cb) {
  const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
  if (!ok) return cb(new Error("Kun bildefiler er tillatt (jpeg/png/webp/gif)."));
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    files: 20,
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

// auth først, så admin-sjekk
router.use(authMiddleware);
router.use(requireAdmin);

/**
 * GET /api/admin/grenselos/grenselos-episodes
 *
 * Admin: Returnerer:
 * - episodes: FLAT liste (bakoverkompatibel med eksisterende AdminScreen)
 * - episodesByContinent: gruppert objekt
 *
 * Galleri (uavhengig av bruker):
 * - Finn "beste" trip per episode:
 *   - foretrekk trip med bilder i gallery
 *   - ellers nyeste trip
 */
router.get("/grenselos-episodes", async (_req, res) => {
  try {
    const episodes = await fetchGrenselosEpisodes(); // MÅ være Array
    if (!Array.isArray(episodes)) {
      throw new Error("fetchGrenselosEpisodes() må returnere en array.");
    }

    const episodeIds = episodes.map((ep) => ep.id).filter(Boolean);

    // Finn beste trip per episode (uavhengig av bruker)
    let tripsByEpisodeId = {};
    if (episodeIds.length > 0) {
      const tripsRes = await pool.query(
        `
        SELECT DISTINCT ON (source_episode_id)
          id,
          user_id,
          source_episode_id,
          gallery,
          created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = ANY($1)
        ORDER BY
          source_episode_id,
          (jsonb_array_length(COALESCE(gallery, '[]'::jsonb)) > 0) DESC,
          created_at DESC
        `,
        [episodeIds]
      );

      tripsByEpisodeId = tripsRes.rows.reduce((acc, row) => {
        acc[row.source_episode_id] = row;
        return acc;
      }, {});
    }

    // Bygg flat liste med galleri
    const flat = episodes.map((ep) => {
      const trip = tripsByEpisodeId[ep.id] || null;
      return {
        episode_id: ep.id,
        name: ep.name,
        description: ep.description,
        release_date: ep.release_date,
        image: ep.image,
        external_url: ep.external_url,

        trip_id: trip ? trip.id : null,
        trip_user_id: trip ? trip.user_id : null,
        gallery: trip?.gallery ? parseJsonArray(trip.gallery) : [],
      };
    });

    // Gruppér basert på flat liste (inkl. galleri)
    const episodesByContinent = groupEpisodesByContinent(
      flat.map((x) => ({
        // group-funksjonen forventer {id,name,description,...}
        id: x.episode_id,
        name: x.name,
        description: x.description,
        release_date: x.release_date,
        image: x.image,
        external_url: x.external_url,
        // beholder admin-felter:
        trip_id: x.trip_id,
        trip_user_id: x.trip_user_id,
        gallery: x.gallery,
      }))
    );

    // Konverter tilbake til samme shape inne i grupper
    const groupedOut = {};
    for (const [continent, eps] of Object.entries(episodesByContinent)) {
      groupedOut[continent] = (eps || []).map((ep) => ({
        episode_id: ep.id,
        continent,
        name: ep.name,
        description: ep.description,
        release_date: ep.release_date,
        image: ep.image,
        external_url: ep.external_url,
        trip_id: ep.trip_id || null,
        trip_user_id: ep.trip_user_id || null,
        gallery: Array.isArray(ep.gallery) ? ep.gallery : [],
      }));
    }

    return res.json({
      episodes: flat, // bakoverkompatibel
      episodesByContinent: groupedOut,
    });
  } catch (e) {
    console.error("[adminGrenselos] GET /grenselos-episodes error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente episoder/galleri." });
  }
});

/**
 * POST /api/admin/grenselos/grenselos-episodes/:episodeId/gallery
 * Admin: Setter galleri manuelt (JSON) på "canonical" admin-trip for episoden.
 *
 * Canonical:
 * - Finn/oppdater en admin-owned trip for episoden (req.user.id)
 */
router.post("/grenselos-episodes/:episodeId/gallery", async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { gallery } = req.body || {};

    if (!Array.isArray(gallery)) {
      return res.status(400).json({
        error: "Galleri må være en liste (array) med objekter: [{ url, title, caption }]",
      });
    }

    const episodes = await fetchGrenselosEpisodes(); // array
    const episode = Array.isArray(episodes) ? episodes.find((e) => e.id === episodeId) : null;

    if (!episode) {
      return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
    }

    // Canonical admin-owner
    const tripId = await ensureTripForEpisode(episode, req.user.id);

    const update = await pool.query(
      `
      UPDATE trips
      SET gallery = $1
      WHERE id = $2
      RETURNING id, source_episode_id, gallery
      `,
      [JSON.stringify(gallery), tripId]
    );

    if (update.rowCount === 0) {
      return res.status(404).json({ error: "Trip ikke funnet." });
    }

    return res.json({
      ok: true,
      tripId,
      episode_id: update.rows[0].source_episode_id,
      gallery: parseJsonArray(update.rows[0].gallery),
    });
  } catch (e) {
    console.error("[adminGrenselos] POST /gallery error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke lagre galleri for episoden." });
  }
});

/**
 * POST /api/admin/grenselos/grenselos-episodes/:episodeId/gallery-upload
 * Form-data: images[]
 *
 * Lagrer filer under:
 *   uploadDir/grenselos-gallery/<episodeId>/<filename>
 * og URL blir:
 *   /uploads/grenselos-gallery/<episodeId>/<filename>
 *
 * NB: Skriver til canonical admin-trip (req.user.id), men lesing i GET er uavhengig av bruker.
 */
router.post(
  "/grenselos-episodes/:episodeId/gallery-upload",
  upload.array("images", 20),
  async (req, res) => {
    try {
      const episodeId = String(req.params.episodeId || "").trim();
      if (!episodeId) return res.status(400).json({ error: "Mangler episodeId." });

      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: "Ingen bildefiler ble lastet opp." });
      }

      const episodes = await fetchGrenselosEpisodes(); // array
      const episode = Array.isArray(episodes) ? episodes.find((e) => e.id === episodeId) : null;

      if (!episode) {
        return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
      }

      // Canonical admin trip for skriving
      const tripId = await ensureTripForEpisode(episode, req.user.id);

      const tripRes = await pool.query(`SELECT gallery FROM trips WHERE id = $1 LIMIT 1`, [tripId]);
      if (tripRes.rowCount === 0) {
        return res.status(404).json({ error: "Trip ikke funnet." });
      }

      const existingGallery = parseJsonArray(tripRes.rows[0]?.gallery);
      const epSeg = safeSegment(episodeId);

      const newItems = files.map((file, idx) => ({
        url: `/uploads/grenselos-gallery/${epSeg}/${file.filename}`,
        title: `Bilde ${existingGallery.length + idx + 1}`,
        caption: null,
      }));

      const updatedGallery = [...existingGallery, ...newItems];

      const upd = await pool.query(
        `
        UPDATE trips
        SET gallery = $1
        WHERE id = $2
        RETURNING id, source_episode_id, gallery
        `,
        [JSON.stringify(updatedGallery), tripId]
      );

      return res.json({
        ok: true,
        tripId: upd.rows[0].id,
        episode_id: upd.rows[0].source_episode_id,
        gallery: parseJsonArray(upd.rows[0].gallery),
      });
    } catch (err) {
      console.error("[adminGrenselos] gallery-upload error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Kunne ikke lagre galleri." });
    }
  }
);

export default router;
