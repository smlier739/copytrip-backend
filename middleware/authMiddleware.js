// middleware/authMiddleware.js (ESM)
import jwt from "jsonwebtoken";
import pool from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET;

export default async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();

  if (!token) {
    console.warn("AUTH: missing bearer token", {
      path: req.originalUrl || req.url,
      ua: req.get("user-agent"),
      ip: req.ip,
      requestId: req.requestId,
    });
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
    console.warn("AUTH: jwt.verify failed", {
      msg: err?.message,
      name: err?.name,
      path: req.originalUrl || req.url,
      requestId: req.requestId,
    });
    return res.status(401).json({ error: "Ugyldig eller utløpt token." });
  }

  const userId = decoded?.userId || null;
  if (!userId) {
    console.warn("AUTH: token missing userId", { decodedKeys: Object.keys(decoded || {}) });
    return res.status(401).json({ error: "Ugyldig token (mangler userId)." });
  }

  const { rows } = await pool.query(
    `SELECT id, email, full_name, is_admin, is_premium
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  if (!rows?.[0]) {
    console.warn("AUTH: user not found", { userId, path: req.originalUrl || req.url });
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
}
