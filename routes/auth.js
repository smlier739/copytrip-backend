// routes/auth.js (ESM)

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Resend } from "resend";

import { query } from "../db.js"; // <-- tilpass hvis din query ligger et annet sted
import { sanitizeUser } from "../utils/sanitizeUser.js"; // <-- tilpass/lag hvis du ikke har

const router = express.Router();

/**
 * Hent env på en trygg måte (kaster hvis mangler).
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Mangler miljøvariabel: ${name}`);
  return v;
}

/**
 * Enkel HTML-mail
 */
function resetEmailHtml({ resetUrl }) {
  return `
  <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height:1.4;">
    <h2>Nullstill passord</h2>
    <p>Trykk på knappen under for å velge nytt passord. Lenken varer i 1 time.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}"
         style="background:#16a34a;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;display:inline-block;">
        Nullstill passord
      </a>
    </p>
    <p>Hvis du ikke ba om dette, kan du ignorere e-posten.</p>
    <hr/>
    <p style="color:#6b7280;font-size:12px;">Grenseløs Reise</p>
  </div>
  `;
}

// -------------------------------------------------------
//  SIGNUP
//  POST /api/auth/signup
// -------------------------------------------------------
router.post("/signup", async (req, res) => {
  const {
    email,
    password,
    fullName,
    birthYear,
    homeCity,
    homeCountry,
    travelStyle,
    budgetPerDay,
    experienceLevel
  } = req.body || {};

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: "Navn, e-post og passord må fylles ut." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedName = String(fullName).trim();

  const birthYearValue =
    birthYear === null || birthYear === "" || birthYear === undefined
      ? null
      : Number(birthYear);

  const budgetPerDayValue =
    budgetPerDay === null || budgetPerDay === "" || budgetPerDay === undefined
      ? null
      : Number(budgetPerDay);

  try {
    const JWT_SECRET = requireEnv("JWT_SECRET");

    // Sjekk om e-posten allerede finnes
    const exists = await query("SELECT id FROM users WHERE email=$1", [normalizedEmail]);
    if (exists.rowCount > 0) {
      return res.status(400).json({ error: "E-posten er allerede i bruk." });
    }

    const hash = await bcrypt.hash(String(password), 10);

    const insert = await query(
      `
      INSERT INTO users (
        email,
        password_hash,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
        normalizedEmail,
        hash,
        normalizedName,
        Number.isFinite(birthYearValue) ? birthYearValue : null,
        homeCity ? String(homeCity).trim() : null,
        homeCountry ? String(homeCountry).trim() : null,
        travelStyle ? String(travelStyle).trim() : null,
        Number.isFinite(budgetPerDayValue) ? budgetPerDayValue : null,
        experienceLevel ? String(experienceLevel).trim() : null
      ]
    );

    const user = insert.rows?.[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });

    return res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error("Signup-feil:", e);
    return res.status(500).json({ error: "Kunne ikke opprette bruker." });
  }
});

// -------------------------------------------------------
//  LOGIN
//  POST /api/auth/login
// -------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");

  try {
    const JWT_SECRET = requireEnv("JWT_SECRET");

    const result = await query("SELECT * FROM users WHERE email=$1", [normalizedEmail]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(normalizedPassword, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const token = jwt.sign({ userId: row.id }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: sanitizeUser(row) });
  } catch (e) {
    console.error("Login-feil:", e);
    return res.status(500).json({ error: "Kunne ikke logge inn." });
  }
});

// -------------------------------------------------------
//  FORGOT PASSWORD
//  POST /api/auth/forgot-password
// -------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "E-post må fylles inn." });

  const normalizedEmail = String(email).trim().toLowerCase();

  // Alltid samme svar (ikke lekke om e-post finnes)
  const okResponse = {
    ok: true,
    message:
      "Hvis vi finner e-posten i systemet vårt, sender vi instruksjoner for å nullstille passordet."
  };

  try {
    const JWT_SECRET = requireEnv("JWT_SECRET");
    const RESEND_API_KEY = requireEnv("RESEND_API_KEY");
    const RESEND_FROM = requireEnv("RESEND_FROM");
    const FRONTEND_BASE_URL = requireEnv("FRONTEND_BASE_URL");

    const resend = new Resend(RESEND_API_KEY);

    const result = await query("SELECT id, email FROM users WHERE email=$1", [normalizedEmail]);
    if (result.rowCount === 0) {
      return res.json(okResponse);
    }

    const userId = result.rows[0].id;

    const resetToken = jwt.sign(
      { userId, type: "password_reset" },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    const base = FRONTEND_BASE_URL.replace(/\/+$/, "");
    const resetUrl = `${base}/endre-passord-i-grenselos-reise-appen/?token=${encodeURIComponent(resetToken)}`;

    const sendRes = await resend.emails.send({
      from: RESEND_FROM,
      to: normalizedEmail,
      subject: "Nullstill passord – Grenseløs Reise",
      html: resetEmailHtml({ resetUrl })
    });

    if (sendRes?.error) {
      console.error("❌ Resend send-feil:", { to: normalizedEmail, error: sendRes.error });
      return res.json(okResponse);
    }

    console.log("✅ Resend forgot-password sendt:", {
      to: normalizedEmail,
      id: sendRes?.data?.id || sendRes?.id,
      from: RESEND_FROM
    });

    return res.json(okResponse);
  } catch (e) {
    console.error("/api/auth/forgot-password-feil:", e);
    // Returner okResponse for å unngå konto-eksponering
    return res.json(okResponse);
  }
});

// -------------------------------------------------------
//  RESET PASSWORD
//  POST /api/auth/reset-password
// -------------------------------------------------------
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "Mangler token eller passord (min 6 tegn)." });
    }

    const JWT_SECRET = requireEnv("JWT_SECRET");

    let decoded;
    try {
      decoded = jwt.verify(String(token), JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Ugyldig eller utløpt reset-token." });
    }

    if (!decoded?.userId || decoded?.type !== "password_reset") {
      return res.status(401).json({ error: "Ugyldig reset-token." });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);

    const r = await query(
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,email,full_name`,
      [hash, decoded.userId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/auth/reset-password-feil:", e);
    return res.status(500).json({ error: "Kunne ikke resette passord." });
  }
});

// -------------------------------------------------------
//  DEV: TEST EMAIL
//  POST /api/auth/dev/test-email
// -------------------------------------------------------
router.post("/dev/test-email", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }

    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: "Mangler 'to'." });

    const RESEND_API_KEY = requireEnv("RESEND_API_KEY");
    const RESEND_FROM = requireEnv("RESEND_FROM");

    const resend = new Resend(RESEND_API_KEY);

    const out = await resend.emails.send({
      from: RESEND_FROM,
      to: String(to).trim(),
      subject: "Test fra Grenseløs Reise",
      html: "<p>Dette er en test. Hvis du ser denne er Resend OK ✅</p>"
    });

    return res.json({ ok: true, out });
  } catch (e) {
    console.error("test-email feilet:", e);
    return res.status(500).json({ error: e?.message || "test-email feilet" });
  }
});

export default router;
