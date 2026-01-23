// middleware/errorHandler.js (ESM-friendly)
// Bruk: app.use(errorHandler) helt til slutt (etter routes)

import multer from "multer";

function isClientErrorMessage(msg) {
  const m = String(msg || "").toLowerCase();

  // Stram og eksplisitt whitelist av kjente "brukerfeil"
  return (
    m.includes("kun jpg") ||
    m.includes("png") ||
    m.includes("webp") ||
    m.includes("heic") ||
    m.includes("heif") ||
    m.includes("file too large") ||
    m.includes("too large") ||
    m.includes("payload too large") ||
    m.includes("tillatt") || // behold hvis du faktisk bruker dette mønsteret
    m.includes("ugyldig") ||
    m.includes("invalid") ||
    m.includes("bad request")
  );
}

function normalizeErrorMessage(err) {
  // Unngå rare objekter i message
  if (!err) return "Uventet serverfeil.";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  return "Uventet serverfeil.";
}

// Express error middleware: (err, req, res, next)
export function errorHandler(err, req, res, next) {
  if (!err) return next();

  const msg = normalizeErrorMessage(err);

  // 0) Hvis headers allerede er sendt, la Express håndtere resten
  if (res.headersSent) return next(err);

  // 1) Multerfeil -> 400
  if (err instanceof multer.MulterError) {
    // Typiske multer codes: LIMIT_FILE_SIZE, LIMIT_UNEXPECTED_FILE, etc.
    const human =
      err.code === "LIMIT_FILE_SIZE"
        ? "Filen er for stor. Maks 12MB."
        : msg;

    return res.status(400).json({ error: human });
  }

  // 2) Våre validerings-/brukerfeil -> 400
  if (isClientErrorMessage(msg)) {
    return res.status(400).json({ error: msg });
  }

  // 3) Status på Error-objekt (hvis du setter err.status / err.statusCode)
  const status =
    Number.isInteger(err.statusCode) ? err.statusCode :
    Number.isInteger(err.status) ? err.status :
    null;

  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: msg });
  }

  // 4) Default -> 500 (logg mer enn du eksponerer)
  console.error("❌ Unhandled error:", {
    message: msg,
    name: err?.name,
    code: err?.code,
    stack: err?.stack,
    path: req?.originalUrl,
    method: req?.method,
  });

  return res.status(500).json({ error: "Uventet serverfeil." });
}
