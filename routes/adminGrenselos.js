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
import { uploadDir } from "../services/uploads/communityUpload.js";

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

// ---------------------------------------------------------
// Multer storage
// ---------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const episodeId = safeSegment(req.params.episodeId);
    const dest = path.join(GALLERY_ROOT, episodeId);
    try {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const original = file.originalname || "image";
    const safeName = original.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

// Kun bilder (hold deg til det du støtter ellers i appen)
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
 * GET /api/admin/grenselos-episodes
 * Returnerer episoder + ev. eksisterende galleri for "per bruker"-trip
 */
router.get("/grenselos-episodes", async (req, res) => {
  try {
    const episodes = await fetchGrenselosEpisodes();
    if (!Array.isArray(episodes)) {
      throw new Error("fetchGrenselosEpisodes() ga ikke en liste.");
    }

    const episodeIds = episodes.map((ep) => ep.id).filter(Boolean);

    // hent nyeste trip per episode for denne brukeren
    let tripsByEpisodeId = {};
    if (episodeIds.length > 0) {
      const tripsRes = await pool.query(
        `
        SELECT id, source_episode_id, gallery, created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND user_id = $1
          AND source_episode_id = ANY($2)
        ORDER BY source_episode_id ASC, created_at DESC
        `,
        [req.user.id, episodeIds]
      );

      tripsByEpisodeId = tripsRes.rows.reduce((acc, row) => {
        if (!acc[row.source_episode_id]) acc[row.source_episode_id] = row;
        return acc;
      }, {});
    }

    const data = episodes.map((ep) => {
      const trip = tripsByEpisodeId[ep.id] || null;

      return {
        episode_id: ep.id,
        name: ep.name,
        description: ep.description,
        release_date: ep.release_date,
        image: ep.image,
        external_url: ep.external_url,
        trip_id: trip ? trip.id : null,
        gallery: trip?.gallery ? parseJsonArray(trip.gallery) : [],
      };
    });

    return res.json({ episodes: data });
  } catch (e) {
    console.error("[adminGrenselos] GET /grenselos-episodes error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente episoder/galleri." });
  }
});

/**
 * POST /api/admin/grenselos-episodes/:episodeId/gallery
 * Setter galleri manuelt (JSON)
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

    const episodes = await fetchGrenselosEpisodes();
    const episode = episodes.find((e) => e.id === episodeId);

    if (!episode) {
      return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
    }

    // per bruker (canonical)
    const tripId = await ensureTripForEpisode(episode, req.user.id);

    const update = await pool.query(
      `
      UPDATE trips
      SET gallery = $1
      WHERE id = $2 AND user_id = $3
      RETURNING id, source_episode_id, gallery
      `,
      [JSON.stringify(gallery), tripId, req.user.id]
    );

    if (update.rowCount === 0) {
      return res.status(404).json({ error: "Trip ikke funnet/tilgang nektet." });
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
 * POST /api/admin/grenselos-episodes/:episodeId/gallery-upload
 * Form-data: images[]
 * Lagrer filer under:
 *   uploadDir/grenselos-gallery/<episodeId>/<filename>
 * og URL blir:
 *   /uploads/grenselos-gallery/<episodeId>/<filename>
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

      const episodes = await fetchGrenselosEpisodes();
      const episode = episodes.find((e) => e.id === episodeId);
      if (!episode) {
        return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
      }

      // per bruker (canonical)
      const tripId = await ensureTripForEpisode(episode, req.user.id);

      // hent eksisterende galleri for denne tripen
      const tripRes = await pool.query(
        `SELECT gallery FROM trips WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [tripId, req.user.id]
      );

      if (tripRes.rowCount === 0) {
        return res.status(404).json({ error: "Trip ikke funnet/tilgang nektet." });
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
        WHERE id = $2 AND user_id = $3
        RETURNING id, source_episode_id, gallery
        `,
        [JSON.stringify(updatedGallery), tripId, req.user.id]
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
