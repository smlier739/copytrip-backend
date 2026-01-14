// middleware/requireAdmin.js
export function requireAdmin(req, res, next) {
  // Forutsetter at du har auth middleware som setter req.user
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!req.user.is_admin) return res.status(403).json({ error: "Forbidden" });
  next();
}
