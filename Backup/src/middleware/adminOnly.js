// backend/src/middleware/adminOnly.js
import { query } from "../db/query.js";

// -------------------------------------------------------
//  AUTH MIDDLEWARE
// -------------------------------------------------------

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");

  if (!token) {
    return res.status(401).json({ error: "Manglende Authorization header." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Hent bruker fra DB slik at vi alltid har is_admin + navn tilgjengelig
    const u = await query(
      `SELECT id, email, full_name, is_admin, is_premium FROM users WHERE id=$1`,
      [decoded.userId]
    );

    if (u.rowCount === 0) {
      return res.status(401).json({ error: "Bruker ikke funnet." });
    }

    const user = u.rows[0];
    req.user = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      is_admin: !!user.is_admin,
      is_premium: !!user.is_premium
    };

    next();
  } catch (err) {
    console.warn("JWT-feil:", err.message);
    res.status(401).json({ error: "Ugyldig eller utløpt token." });
  }
}


export async function adminOnlyMiddleware(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: "Mangler innlogget bruker." });

  const result = await query(`SELECT is_admin FROM users WHERE id=$1`, [req.user.id]);
  if (result.rowCount === 0 || !result.rows[0].is_admin) {
    return res.status(403).json({ error: "Kun admin har tilgang." });
  }
  next();
}

// -------------------------------------------------------
//  SJEKK ADMIN
// -------------------------------------------------------

async function adminOnlyMiddleware(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: "Mangler innlogget bruker." });
    }

    const result = await query(
      `SELECT is_admin FROM users WHERE id=$1`,
      [req.user.id]
    );

    if (result.rowCount === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: "Kun admin har tilgang." });
    }

    next();
  } catch (e) {
    console.error("adminOnlyMiddleware-feil:", e);
    res.status(500).json({ error: "Kunne ikke verifisere admin-rettigheter." });
  }
}

function canSeeTripDetails(req) {
  return !!(req.user?.is_admin || req.user?.is_premium);
}
