const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Filopplasting for galleri / virtuell reise ----------

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));

// 🧱 Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const safeName = file.originalname
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "");

    cb(null, `${unique}-${safeName}`);
  }
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

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 12 * 1024 * 1024 }
});

// Bruk DATABASE_URL hvis den finnes (Render), ellers klassisk lokalt oppsett
let pool;

if (process.env.DATABASE_URL) {
  console.log("Bruker DATABASE_URL for Postgres-tilkobling");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false, // nødvendig for mange hosted Postgres (inkl. Render)
    },
  });
} else {
  console.log("Bruker lokal DB-konfig (DB_HOST/DB_USER/...)");
  pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "copytrip_user",
    password: process.env.DB_PASSWORD || "superhemmelig",
    database: process.env.DB_NAME || "copytrip",
  });
}

const JWT_SECRET = process.env.JWT_SECRET || "superhemmelig-dev-token";

const openaiConfig = {
  apiKey: process.env.OPENAI_API_KEY,
};
if (process.env.OPENAI_PROJECT_ID) {
  openaiConfig.project = process.env.OPENAI_PROJECT_ID;
}
const openai = new OpenAI(openaiConfig);

function assertEnvOrThrow() {
  const missing = [];
  if (!JWT_SECRET) missing.push("JWT_SECRET");
  if (!APP_BASE_URL) missing.push("APP_BASE_URL");
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!RESEND_FROM) missing.push("RESEND_FROM");
  if (missing.length) {
    const msg = `Mangler miljøvariabler: ${missing.join(", ")}`;
    console.error("❌", msg);
    throw new Error(msg);
  }
}

function sanitizeUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

