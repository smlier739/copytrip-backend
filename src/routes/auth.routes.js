import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import { query } from "../db/query.js";
import { JWT_SECRET, RESEND_FROM, APP_BASE_URL } from "../config/env.js";
import { resend } from "../config/resend.js";

const router = express.Router();

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}



// --- POST /api/auth/forgot-password ---
// Bruker users.reset_token_hash + users.reset_token_expires
router.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: "Ugyldig e-post." });

    const userR = await query(`SELECT id, email FROM users WHERE email=$1`, [email]);

    // Ikke lekke om bruker finnes
    if (userR.rowCount === 0) return res.json({ ok: true });

    const userId = userR.rows[0].id;

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 time

    await query(
      `
      UPDATE users
      SET reset_token_hash=$1, reset_token_expires=$2, updated_at=now()
      WHERE id=$3
      `,
      [tokenHash, expiresAt, userId]
    );

    // Send e-post (hvis resend er konfigurert)
    if (resend && RESEND_FROM) {
      const resetLink = `${APP_BASE_URL || ""}/reset-password?token=${rawToken}`;

      await resend.emails.send({
        from: RESEND_FROM,
        to: email,
        subject: "Tilbakestill passord",
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
            <p>Du ba om å tilbakestille passordet ditt.</p>
            <p>Trykk her for å tilbakestille:</p>
            <p><a href="${resetLink}">${resetLink}</a></p>
            <p>Lenken er gyldig i 1 time.</p>
          </div>
        `,
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("forgot-password error:", e);
    return res.status(500).json({ error: "Kunne ikke starte passord-reset." });
  }
});

// --- POST /api/auth/reset-password ---
// Body: { token, new_password }
router.post("/api/auth/reset-password", async (req, res) => {
  try {
    const token = String(req.body.token || "");
    const newPassword = String(req.body.new_password || req.body.newPassword || "");

    if (!token) return res.status(400).json({ error: "Mangler token." });
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: "Passord må være minst 8 tegn." });

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const r = await query(
      `
      SELECT id, reset_token_expires
      FROM users
      WHERE reset_token_hash=$1
      `,
      [tokenHash]
    );

    if (r.rowCount === 0) return res.status(400).json({ error: "Ugyldig token." });

    const { id, reset_token_expires } = r.rows[0];

    if (!reset_token_expires || new Date(reset_token_expires).getTime() < Date.now()) {
      return res.status(400).json({ error: "Token er utløpt." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await query(
      `
      UPDATE users
      SET password_hash=$1,
          reset_token_hash=NULL,
          reset_token_expires=NULL,
          updated_at=now()
      WHERE id=$2
      `,
      [passwordHash, id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset-password error:", e);
    return res.status(500).json({ error: "Kunne ikke tilbakestille passord." });
  }
});

// --- POST /api/dev/test-email ---
router.post("/api/dev/test-email", async (req, res) => {
  try {
    const to = normalizeEmail(req.body.to);
    if (!to || !isValidEmail(to)) return res.status(400).json({ error: "Ugyldig e-post." });

    if (!resend || !RESEND_FROM)
      return res.status(400).json({ error: "Resend er ikke konfigurert (RESEND_API_KEY/RESEND_FROM)." });

    await resend.emails.send({
      from: RESEND_FROM,
      to,
      subject: "Test e-post fra Copytrip",
      html: "<p>Dette er en test.</p>",
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("test-email error:", e);
    return res.status(500).json({ error: "Kunne ikke sende test e-post." });
  }
});

export default router;
