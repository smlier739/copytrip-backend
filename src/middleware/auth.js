// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import { query } from "../db/query.js";

const JWT_SECRET = process.env.JWT_SECRET || "superhemmelig-dev-token";

import { getRevenueCatEntitlements } from "../services/revenuecat.js";

export async function authMiddleware(req, res, next) {
  // ... JWT-verifisering som før

  const user = u.rows[0];

  let rcEntitlements = {};
  try {
    rcEntitlements = await getRevenueCatEntitlements(user.id);
  } catch (e) {
    console.warn("RevenueCat lookup feilet:", e.message);
  }

  req.user = {
    id: user.id,
    email: user.email,
    is_admin: !!user.is_admin,

    // 🔑 ENE SANNHET
    is_pro: !!rcEntitlements["Pro"]
  };

  next();
}

export function requirePro(req, res, next) {
  if (req.user?.is_admin || req.user?.is_pro) return next();
  return res.status(402).json({ error: "Krever Pro/Premium for tilgang." });
}
