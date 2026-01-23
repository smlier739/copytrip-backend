// routes/profile.js (ESM)

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";

// TILPASS til din db-export (pool/query). Jeg antar du har query(...) tilgjengelig:
import { query } from "../db.js";

const router = express.Router();

function toNullableNumber(v) {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNullableTrimmedString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// -------------------------------------------------------
// GET /api/profile
// -------------------------------------------------------
router.get("/", authMiddleware, async (req, res) => {
  try {
    const id = req.user?.id;
    if (!id) return res.status(401).json({ error: "Ikke innlogget." });

    const result = await query(
      `
      SELECT
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      FROM users
      WHERE id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Profil ikke funnet." });
    }

    return res.json({ user: result.rows[0] });
  } catch (e) {
    console.error("[profile] GET / error:", e);
    return res.status(500).json({ error: "Kunne ikke hente profil." });
  }
});

// -------------------------------------------------------
// POST /api/profile/update
// -------------------------------------------------------
router.post("/update", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Ikke innlogget." });

    // Må matche appen (camelCase)
    const {
      fullName,
      birthYear,
      homeCity,
      homeCountry,
      travelStyle,
      budgetPerDay,
      experienceLevel
    } = req.body || {};

    // Normaliser input
    const fullNameValue = toNullableTrimmedString(fullName);
    const birthYearValue = toNullableNumber(birthYear);
    const budgetPerDayValue = toNullableNumber(budgetPerDay);

    const homeCityValue = toNullableTrimmedString(homeCity);
    const homeCountryValue = toNullableTrimmedString(homeCountry);
    const travelStyleValue = toNullableTrimmedString(travelStyle);
    const experienceLevelValue = toNullableTrimmedString(experienceLevel);

    // Viktig: COALESCE gjør at "ikke sendt" (null) ikke overskriver eksisterende,
    // men hvis du faktisk ønsker å kunne "tømme" felt fra appen, må du sende eksplisitt null
    // og skille mellom "undefined" og "null". (Se note under.)
    const { rows, rowCount } = await query(
      `
      UPDATE users
      SET
        full_name        = COALESCE($1, full_name),
        birth_year       = COALESCE($2, birth_year),
        home_city        = COALESCE($3, home_city),
        home_country     = COALESCE($4, home_country),
        travel_style     = COALESCE($5, travel_style),
        budget_per_day   = COALESCE($6, budget_per_day),
        experience_level = COALESCE($7, experience_level)
      WHERE id = $8
      RETURNING
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      `,
      [
        fullNameValue,
        birthYearValue,
        homeCityValue,
        homeCountryValue,
        travelStyleValue,
        budgetPerDayValue,
        experienceLevelValue,
        userId
      ]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Fant ikke bruker å oppdatere." });
    }

    return res.json({ user: rows[0] });
  } catch (e) {
    console.error("[profile] POST /update error:", e);
    return res.status(500).json({ error: "Kunne ikke oppdatere profil." });
  }
});

export default router;
