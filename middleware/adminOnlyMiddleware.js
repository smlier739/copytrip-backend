// middleware/adminOnlyMiddleware.js (ESM)
export default function adminOnlyMiddleware(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!req.user.is_admin) return res.status(403).json({ error: "Forbidden (admin only)" });
  return next();
}

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
