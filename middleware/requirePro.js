// middleware/requirePro.js (ESM)

export default function requirePro(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Ikke autentisert." });
  }

  if (req.user.is_admin === true || req.user.is_premium === true) {
    return next();
  }

  return res.status(403).json({
    error: "Denne funksjonen krever Pro/Premium.",
    code: "PRO_REQUIRED",
  });
}
