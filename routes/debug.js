// routes/debug.js (ESM)

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";

import { query } from "../services/db/query.js";
import { fetchGrenselosEpisodes } from "../services/spotify/fetchGrenselosEpisodes.js";

const router = express.Router();

/**
 * Dersom du har uploadDir definert sentralt et annet sted (anbefalt),
 * importer den i stedet. Her setter vi en trygg default:
 * - Render disk: /var/data/uploads (som du brukte tidligere)
 * - Lokal: ./uploads
 */
const uploadDir =
  process.env.UPLOAD_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "uploads");

/**
 * Helper: parse felt som kan være JSON-string/array/null -> array
 */
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

/**
 * Masker passord i DATABASE_URL-ish strenger.
 */
function maskDbUrl(dbUrl) {
  if (!dbUrl) return null;
  // user:pass@ -> user:***@
  return String(dbUrl).replace(/:(.*?)@/, ":***@");
}

// -------------------------------------------------------
//  DEBUG: DB INFO
// -------------------------------------------------------
router.get("/db-info", async (req, res) => {
  try {
    const r = await query(`
      SELECT
        current_database() AS db,
        current_user AS "user",
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        current_schema() AS schema,
        current_setting('search_path') AS search_path
    `);

    const dbUrl = process.env.DATABASE_URL || "";
    const safeDbUrl = maskDbUrl(dbUrl);

    return res.json({
      ok: true,
      env: {
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        databaseUrlHostHint: safeDbUrl
      },
      db: r.rows[0] || null
    });
  } catch (e) {
    console.error("[debug] /db-info error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "db-info feil" });
  }
});

// -------------------------------------------------------
//  DEBUG: LIST TABLES
// -------------------------------------------------------
router.get("/db-tables", async (req, res) => {
  try {
    const r = await query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name
    `);

    return res.json({ ok: true, tables: r.rows || [] });
  } catch (e) {
    console.error("[debug] /db-tables error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "db-tables feil" });
  }
});

// -------------------------------------------------------
//  DEBUG: GRENSELØS COUNT (ADMIN)
// -------------------------------------------------------
router.get("/grenselos-count", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const episodes = await fetchGrenselosEpisodes();

    const list = Array.isArray(episodes) ? episodes : [];
    const total = list.length;
    const first = list[0] || null;
    const last = list[total - 1] || null;

    console.log(`[debug/grenselos-count] Fant ${total} episoder fra Spotify`);

    return res.json({
      ok: true,
      totalEpisodes: total,
      firstEpisode: first
        ? { id: first.id, name: first.name, release_date: first.release_date }
        : null,
      lastEpisode: last
        ? { id: last.id, name: last.name, release_date: last.release_date }
        : null
    });
  } catch (e) {
    console.error("[debug] /grenselos-count-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente antall Grenseløs-episoder." });
  }
});

// -------------------------------------------------------
//  DEBUG: INSPEKTÉR ÉN TRIP + EV. SYSTEM-TRIP (ADMIN)
// -------------------------------------------------------
router.get("/trip/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await query(
      `
      SELECT *
      FROM trips
      WHERE id = $1
      `,
      [tripId]
    );

    if (tripRes.rowCount === 0) {
      return res.status(404).json({ error: "Fant ikke trip med denne ID-en." });
    }

    const tripRow = tripRes.rows[0];

    const parsedTrip = {
      ...tripRow,
      stops: parseJsonArray(tripRow.stops),
      packing_list: parseJsonArray(tripRow.packing_list),
      gallery: parseJsonArray(tripRow.gallery),
      hotels: parseJsonArray(tripRow.hotels),
      experiences: parseJsonArray(tripRow.experiences)
    };

    // canonical system-trip for samme episode (hvis relevant)
    let systemTripRaw = null;
    let systemTripParsed = null;

    if (tripRow.source_episode_id) {
      const sysRes = await query(
        `
        SELECT *
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [tripRow.source_episode_id]
      );

      if (sysRes.rowCount > 0) {
        systemTripRaw = sysRes.rows[0];
        systemTripParsed = {
          ...systemTripRaw,
          stops: parseJsonArray(systemTripRaw.stops),
          packing_list: parseJsonArray(systemTripRaw.packing_list),
          gallery: parseJsonArray(systemTripRaw.gallery),
          hotels: parseJsonArray(systemTripRaw.hotels),
          experiences: parseJsonArray(systemTripRaw.experiences)
        };
      }
    }

    return res.json({
      ok: true,
      tripId,
      userTrip: { raw: tripRow, parsed: parsedTrip },
      systemTrip: systemTripRaw ? { raw: systemTripRaw, parsed: systemTripParsed } : null
    });
  } catch (e) {
    console.error("[debug] /trip/:id-feil:", e);
    return res.status(500).json({ error: "Kunne ikke inspisere trip." });
  }
});

// -------------------------------------------------------
//  DEBUG: UPLOADS LISTING (ADMIN)
// -------------------------------------------------------
router.get("/uploads", authMiddleware, requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(uploadDir);
    return res.json({ ok: true, uploadDir, count: files.length, files });
  } catch (e) {
    return res.status(500).json({ ok: false, uploadDir, error: e?.message || "uploads-feil" });
  }
});

// -------------------------------------------------------
//  HEALTH CHECK (PUBLIC)
// -------------------------------------------------------
router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

export default router;
