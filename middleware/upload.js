// middleware/upload.js (ESM)
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base-dir = prosjektroten/backend (tilpass hvis upload-mappa skal ligge et annet sted)
const projectDir = path.join(__dirname, "..");

// -------------------------
// Filopplasting (galleri / virtuell reise)
// -------------------------
export const uploadDir = process.env.UPLOAD_DIR || path.join(projectDir, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 🧱 Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const safeName = (file.originalname || "upload")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, `${unique}-${safeName}`);
  },
});

// ✅ Tillatte typer (HEIC BLOKKERT)
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mimeOk = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const extOk = ALLOWED_EXTS.includes(ext);

  if (mimeOk && extOk) return cb(null, true);

  console.warn("❌ Avvist bildefil:", file.originalname, file.mimetype);
  cb(new Error("Kun JPG, PNG og WEBP er tillatt. HEIC/HEIF støttes ikke."));
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 12 * 1024 * 1024 },
});
