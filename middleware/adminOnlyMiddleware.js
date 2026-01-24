// middleware/adminOnlyMiddleware.js (ESM)

/**
 * Krever at authMiddleware allerede har satt req.user.
 * Forventer at req.user.is_admin er boolean.
 */
export default function adminOnlyMiddleware(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.user.is_admin !== true) {
      return res.status(403).json({ error: "Forbidden (admin only)" });
    }

    return next();
  } catch (e) {
    console.error("adminOnlyMiddleware-feil:", e);
    return res.status(500).json({ error: "Kunne ikke verifisere admin-rettigheter." });
  }
}
