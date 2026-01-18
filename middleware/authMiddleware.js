// src/middleware/authMiddleware.js (ESM)
import jwt from "jsonwebtoken";
import pool from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET;

export default async function authMiddleware(req, res, next) {
  try {
    if (!JWT_SECRET) {
      console.error("JWT_SECRET is missing in environment");
      return res.status(500).json({ error: "Server config error (JWT_SECRET mangler)." });
    }

    const auth = req.headers.authorization || "";

    // Robust Bearer parsing
    // Accept: "Bearer <token>" (case-insensitive), tolerate extra spaces
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1]?.trim();

    if (!token) {
      console.warn("Missing/invalid Authorization header", {
        method: req.method,
        path: req.originalUrl || req.url,
        ip: req.ip,
        ua: req.get("user-agent"),
        requestId: req.requestId,
      });
      return res.status(401).json({ error: "Manglende Authorization header." });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    console.log("JWT decoded payload keys:", Object.keys(decoded || {}));

    // Support common payload shapes
    const userId =
      decoded?.userId ||
      decoded?.id ||
      decoded?.user_id ||
      decoded?.sub ||
      null;

    if (!userId) {
      console.warn("JWT payload missing user id", {
        method: req.method,
        path: req.originalUrl || req.url,
        requestId: req.requestId,
        decodedKeys: decoded ? Object.keys(decoded) : [],
      });
      return res.status(401).json({ error: "Ugyldig token (mangler user id)." });
    }

    const { rows } = await pool.query(
      `SELECT id, email, full_name, is_admin, is_premium
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows?.[0]) {
      return res.status(401).json({ error: "Bruker ikke funnet." });
    }

    const user = rows[0];
    req.user = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      is_admin: !!user.is_admin,
      is_premium: !!user.is_premium,
    };

    return next();
  } catch (err) {
    console.warn("JWT-feil:", err?.message, {
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      requestId: req.requestId,
    });
    return res.status(401).json({ error: "Ugyldig eller utløpt token." });
  }
}
