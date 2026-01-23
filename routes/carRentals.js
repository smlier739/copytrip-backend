// backend/routes/carRentals.js (ESM)

import express from "express";
import pool from "../db.js";
import authMiddleware from "../middleware/authMiddleware.js";

import { getUserEntitlements } from "../services/utils/entitlements.js";
import { toArrayMaybe, pickStop1, pickLatLngFromStop, pickTextFromStop } from "../services/utils/tripStops.js";
import { searchCarRentals } from "../services/carRentalsService.js";

const router = express.Router();

// GET: hent bilutleie-forslag knyttet til turens stopp 1 + datoer fra klient
router.get("/trips/:id/car-rentals", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

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

    // canonical override hvis dette er en "brukertur" fra episode
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
    const queryText = pickTextFromStop(stop1);
    const latlng = pickLatLngFromStop(stop1);

    // ISO 8601, f.eks: 2026-01-18T10:00
    const pickup = typeof req.query.pickup === "string" ? req.query.pickup.trim() : "";
    const dropoff = typeof req.query.dropoff === "string" ? req.query.dropoff.trim() : "";

    const all = searchCarRentals({
      queryText: queryText || (latlng ? `${latlng.lat},${latlng.lng}` : ""),
      pickupISO: pickup || null,
      dropoffISO: dropoff || null,
    });

    const full = (all || []).filter((x) => x && typeof x === "object");
    const preview = full.slice(0, 3).map((x) => ({
      id: x.id || null,
      title: x.title || "Bilutleie",
      provider: x.provider || null,
      location: x.location || null,
    }));

    return res.json({
      ok: true,
      tripId,
      destination_text: queryText || null,
      destination_latlng: latlng || null,
      pickup: pickup || null,
      dropoff: dropoff || null,
      car_rentals: isPro ? full : preview,
      entitlements: { isPro, locked: { car_rentals: !isPro } },
      counts: { car_rentals: full.length },
    });
  } catch (e) {
    console.error("/api/trips/:id/car-rentals-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente bilutleie." });
  }
});

export default router;
