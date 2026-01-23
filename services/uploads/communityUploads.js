// backend/services/uploads/communityUpload.js (ESM)

import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default: backend/uploads (to nivå opp fra /services/uploads -> /backend)
const defaultUploadDir = path.resolve(__dirname, "..", "..", "..", "uploads");

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || defaultUploadDir);

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (e) {
  console.error("❌ Kunne ikke opprette uploadDir:", uploadDir, e);
  throw new Error(`Kunne ikke opprette uploadDir: ${uploadDir}`);
}

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

function sanitizeOriginalName(originalname) {
  const base = path.basename(originalname || "upload"); // fjerner evt. path segments
  const cleaned = base
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "");

  // hard limit for å unngå ekstreme filnavn
  return (cleaned || "upload").slice(0, 120);
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mimeOk = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const extOk = ALLOWED_EXTS.includes(ext);

  // Mange iOS HEIC-filer kommer som image/heic eller image/heif
  const isHeicLike = /heic|heif/i.test(file.mimetype) || [".heic", ".heif"].includes(ext);

  if (isHeicLike) {
    const err = new Error("Kun JPG, PNG og WEBP er tillatt. HEIC/HEIF støttes ikke.");
    err.status = 400;
    return cb(err);
  }

  if (mimeOk && extOk) return cb(null, true);

  console.warn("❌ Avvist bildefil:", file.originalname, file.mimetype);
  const err = new Error("Kun JPG, PNG og WEBP er tillatt.");
  err.status = 400;
  return cb(err);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const safeName = sanitizeOriginalName(file.originalname);
    cb(null, `${unique}-${safeName}`);
  },
});

export const communityUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 12 * 1024 * 1024, // 12 MB
    files: 1, // ofte ønskelig per request; juster hvis dere har multi-upload
  },
});
