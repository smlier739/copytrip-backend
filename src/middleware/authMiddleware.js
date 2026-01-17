// src/middleware/authMiddleware.js (ESM)
import jwt from "jsonwebtoken";
import pool from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET;

export default async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");

  if (!token) {
    // logg mer strukturert om du ønsker
    console.warn("Missing Authorization header", {
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      ua: req.get("user-agent"),
      requestId: req.requestId,
    });
    return res.status(401).json({ error: "Manglende Authorization header." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const { rows, rowCount } = await pool.query(
      `SELECT id, email, full_name, is_admin, is_premium
       FROM users
       WHERE id = $1`,
      [decoded.userId]
    );

    if (rowCount === 0) {
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

    next();
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
