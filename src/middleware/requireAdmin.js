// src/middleware/requireAdmin.js (ESM)
export function requireAdmin(req, res, next) {
  // authMiddleware må ha satt req.user
  if (!req.user) {
    return res.status(401).json({ error: "Ikke innlogget." });
  }
  if (!req.user.is_admin) {
    return res.status(403).json({ error: "Krever admin." });
  }
  return next();
}
