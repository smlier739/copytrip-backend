// routes/johnnysTips.js
import express from "express";
import requireAdmin from "../middleware/requireAdmin.js";
import authMiddleware from "../middleware/authMiddleware.js";
import pool from "../db.js";

const router = express.Router();

// GET: innlogget kan hente, men blokker hvis ikke premium/admin
router.get("/:tripId", authMiddleware, async (req, res) => {
  try {
    const { tripId } = req.params;

    // Server-side paywall
    const isAllowed = req.user?.is_admin || req.user?.is_premium;
    if (!isAllowed) {
      return res.status(403).json({ error: "Krever Pluss." });
    }

    const { rows } = await pool.query(
      `SELECT *
       FROM johnnys_tips
       WHERE trip_uuid = $1::uuid
       LIMIT 1`,
      [tripId]
    );

    res.json({ data: rows[0] || null });
  } catch (e) {
    console.error("GET johnnys_tips feilet:", e);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// PUT (upsert): kun admin (Johnny)
router.put("/:tripId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { tripId } = req.params; // trip_uuid (uuid)
    const b = req.body || {};

    // En enkel canonicalisering: bruk trip_uuid som tekst også i trip_id (PK)
    const tripIdText = String(tripId);

    const q = `
      INSERT INTO johnnys_tips (
        trip_id,
        trip_uuid,
        episode_id,

        do_list, dont_list, interpreter_tips, fixer_local_contact, driver_tips,
        safety_tips, scams_to_avoid, etiquette, money_payments, transport_notes,
        health_vaccines, gear_packing, photo_rules, sim_internet, emergency_numbers,
        best_time_to_go, johnny_one_liner, notes,

        payload,
        updated_at
      ) VALUES (
        $1::text,
        $2::uuid,
        $3::text,

        $4::text, $5::text, $6::text, $7::text, $8::text,
        $9::text, $10::text, $11::text, $12::text, $13::text,
        $14::text, $15::text, $16::text, $17::text, $18::text,
        $19::text, $20::text, $21::text,

        $22::jsonb,
        now()
      )
      ON CONFLICT (trip_uuid) DO UPDATE SET
        -- behold PK (trip_id) som den er, men det er greit å synce den også:
        trip_id = EXCLUDED.trip_id,

        episode_id = EXCLUDED.episode_id,
        do_list = EXCLUDED.do_list,
        dont_list = EXCLUDED.dont_list,
        interpreter_tips = EXCLUDED.interpreter_tips,
        fixer_local_contact = EXCLUDED.fixer_local_contact,
        driver_tips = EXCLUDED.driver_tips,
        safety_tips = EXCLUDED.safety_tips,
        scams_to_avoid = EXCLUDED.scams_to_avoid,
        etiquette = EXCLUDED.etiquette,
        money_payments = EXCLUDED.money_payments,
        transport_notes = EXCLUDED.transport_notes,
        health_vaccines = EXCLUDED.health_vaccines,
        gear_packing = EXCLUDED.gear_packing,
        photo_rules = EXCLUDED.photo_rules,
        sim_internet = EXCLUDED.sim_internet,
        emergency_numbers = EXCLUDED.emergency_numbers,
        best_time_to_go = EXCLUDED.best_time_to_go,
        johnny_one_liner = EXCLUDED.johnny_one_liner,
        notes = EXCLUDED.notes,
        payload = EXCLUDED.payload,
        updated_at = now()
      RETURNING *;
    `;

    const params = [
      tripIdText,                 // $1 trip_id (text PK)
      tripId,                     // $2 trip_uuid (uuid)
      b.episode_id || null,       // $3

      b.do_list || null,          // $4
      b.dont_list || null,        // $5
      b.interpreter_tips || null, // $6
      b.fixer_local_contact || null, // $7
      b.driver_tips || null,      // $8

      b.safety_tips || null,      // $9
      b.scams_to_avoid || null,   // $10
      b.etiquette || null,        // $11
      b.money_payments || null,   // $12
      b.transport_notes || null,  // $13

      b.health_vaccines || null,  // $14
      b.gear_packing || null,     // $15
      b.photo_rules || null,      // $16
      b.sim_internet || null,     // $17
      b.emergency_numbers || null,// $18

      b.best_time_to_go || null,  // $19
      b.johnny_one_liner || null, // $20
      b.notes || null,            // $21

      // payload: lagre alt “rått” også (praktisk for fremtidige felter)
      b.payload && typeof b.payload === "object" ? JSON.stringify(b.payload) : JSON.stringify(b),
    ];

    const { rows } = await pool.query(q, params);
    res.json({ data: rows[0] });
  } catch (e) {
    console.error("PUT johnnys_tips feilet:", e);
    res.status(500).json({ error: "Serverfeil" });
  }
});

export default router;
