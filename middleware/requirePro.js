function requirePro(req, res, next) {
  if (req.user?.is_admin || req.user?.is_premium) return next();
  return res.status(402).json({ error: "Krever Pro/Premium for tilgang." });
}
