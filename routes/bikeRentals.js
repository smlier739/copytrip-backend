// backend/routes/bikeRentals.js (ESM)

import express from "express";
import pool from "../db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import {
  toArrayMaybe,
  pickStop1,
  pickLatLngFromStop,
  pickTextFromStop,
} from "../services/utils/tripStops.js";

const router = express.Router();

// GET: destinasjon (stopp 1) for sykkelutleie
router.get("/trips/:id/bike-rentals", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await pool.query(
      `
      SELECT id, user_id, source_episode_id, source_type, stops, created_at
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
    let stops = toArrayMaybe(row.stops);

    // canonical stops for episode-trips
    if (row.source_episode_id) {
      const canonRes = await pool.query(
        `
        SELECT stops
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );

      if (canonRes.rows?.[0]) {
        const canonStops = toArrayMaybe(canonRes.rows[0].stops);
        if (canonStops.length) stops = canonStops;
      }
    }

    const stop1 = pickStop1(stops);
    const latlng = pickLatLngFromStop(stop1);
    const destination_text = pickTextFromStop(stop1);

    // "destination" i en stabil form (til screen)
    const destination = stop1
      ? {
          name:
            stop1.name ||
            stop1.title ||
            stop1.place ||
            stop1.city ||
            null,
          country_code:
            stop1.country_code ||
            stop1.countryCode ||
            stop1.country ||
            null,
          lat: latlng?.lat ?? null,
          lng: latlng?.lng ?? null,
          destination_text: destination_text || null,
          raw: stop1,
        }
      : null;

    // Foreløpig: ingen providers (UI kan alltid vise “Søk i området”)
    return res.json({
      ok: true,
      tripId,
      destination,
      providers: [],
    });
  } catch (e) {
    console.error("/api/trips/:id/bike-rentals feil:", e);
    return res
      .status(500)
      .json({ error: "Kunne ikke hente sykkelutleie-destinasjon." });
  }
});

export default router;
