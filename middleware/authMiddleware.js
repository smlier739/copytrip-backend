// middleware/authMiddleware.js (ESM)
import jwt from "jsonwebtoken";
import pool from "../db.js";

const JWT_SECRET = (process.env.JWT_SECRET || "").trim();

function getBearerToken(req) {
  const auth = String(req.headers?.authorization || "").trim();
  if (!auth) return null;

  // tillat f.eks. "Bearer    <token>"
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

export default async function authMiddleware(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Manglende Authorization header." });
    }

    if (!JWT_SECRET) {
      console.error("AUTH: JWT_SECRET missing on server");
      return res.status(500).json({ error: "Server config error (JWT_SECRET mangler)." });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Ugyldig eller utløpt token." });
    }

    // Støtt både userId og sub (vanlig JWT claim)
    const userId = decoded?.userId || decoded?.sub || null;

    if (!userId) {
      return res.status(401).json({ error: "Ugyldig token (mangler userId)." });
    }

    const q = `
      SELECT id, email, full_name, is_admin, is_premium
      FROM users
      WHERE id = $1
      LIMIT 1
    `;

    const r = await pool.query(q, [userId]);
    const user = r.rows?.[0];

    if (!user) {
      return res.status(401).json({ error: "Bruker ikke funnet." });
    }

    req.user = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      is_admin: user.is_admin === true,
      is_premium: user.is_premium === true,
    };

    return next();
  } catch (e) {
    console.error("AUTH: middleware crashed:", e?.message || e);
    return res.status(500).json({ error: "Uventet serverfeil i auth." });
  }
}
