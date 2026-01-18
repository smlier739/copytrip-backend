// backend/index.js – Grenseløs Reise backend

import dotenv from "dotenv";
dotenv.config({ override: true });

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import axios from "axios";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import fetch from "node-fetch";
import crypto from "crypto";

import adminRoutes from "./routes/admin.js";
import pool from "./db.js"; // ✅ ÉN kilde til DB (ikke re-deklarer pool i index.js)

import johnnysTipsRouter from "./routes/johnnysTips.js";
import authMiddleware from "./middleware/authMiddleware.js";

// -------------------------
// ESM-vennlig __dirname
// -------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------
// App config
// -------------------------
const PORT = process.env.PORT || 4000;
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const JWT_SECRET = process.env.JWT_SECRET || "superhemmelig-dev-token";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM;

// Init Resend
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Debug API-nøkkel (kun prefix)
console.log(
  "DEBUG OPENAI_API_KEY prefix:",
  (process.env.OPENAI_API_KEY || "").slice(0, 12) || "IKKE SATT"
);

const flightDebugLogged = new Set();

// -------------------------
// Express app
// -------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Routes (må komme etter app er opprettet)
app.use("/api/admin", adminRoutes);
app.use("/api/johnnys-tips", johnnysTipsRouter);

// -------------------------
// Filopplasting (galleri / virtuell reise)
// -------------------------
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));

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

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

const openaiConfig = {
  apiKey: process.env.OPENAI_API_KEY,
};
if (process.env.OPENAI_PROJECT_ID) {
  openaiConfig.project = process.env.OPENAI_PROJECT_ID;
}
const openai = new OpenAI(openaiConfig);

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getSpotifyAccessToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error("Mangler SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET i .env");
  }

  const credentials = `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`;
  const encoded = Buffer.from(credentials).toString("base64");

  const resp = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${encoded}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  if (!resp.data?.access_token) {
    throw new Error("Fikk ikke access_token fra Spotify");
  }

  return resp.data.access_token;
}

function makeHotelFallbackUrl(h) {
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(location ? `${name} ${location} hotell` : `${name} hotell`);
  return `https://www.google.com/search?q=${q}`;
}

function makeExperienceFallbackUrl(x) {
  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(location ? `${name} ${location} billetter` : `${name} billetter`);
  return `https://www.google.com/search?q=${q}`;
}

async function getUserEntitlements(userId) {
  const r = await query(`SELECT is_premium, is_admin FROM users WHERE id=$1`, [userId]);
  const u = r.rows?.[0] || {};
  return { isPro: !!(u.is_premium || u.is_admin), is_admin: !!u.is_admin, is_premium: !!u.is_premium };
}

function requirePro(req, res, next) {
  if (req.user?.is_admin || req.user?.is_premium) return next();
  return res.status(402).json({ error: "Krever Pro/Premium for tilgang." });
}

// Bruk søk-fallback (ikke Maps) hvis ingen eksplisitt URL finnes
function makeHotelUrl(h) {
  // 1) Direkte URL-felter
  const direct =
    sanitizeUrl(h?.url) ||
    sanitizeUrl(h?.booking_url) ||
    sanitizeUrl(h?.link) ||
    sanitizeUrl(h?.external_url);

  if (direct) return direct;

  // 2) Fallback: Google-søk (bedre enn maps for hoteller)
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();

  if (!name) return null;

  const q = encodeURIComponent(
    location ? `${name} ${location} hotell` : `${name} hotell`
  );

  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(
    location ? `${name} ${location}` : name
  )}`;
}

function makeExperienceUrl(x) {
  // 1) Prøv eksplisitte URL-felt
  const direct =
    sanitizeUrl(x?.url) ||
    sanitizeUrl(x?.booking_url) ||
    sanitizeUrl(x?.ticket_url) ||
    sanitizeUrl(x?.link) ||
    sanitizeUrl(x?.external_url);

  if (direct) return direct;

  // 2) Fallback: Google-søk på billetter
  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();

  if (!name) return null;

  const q = encodeURIComponent(
    location ? `${name} ${location} billetter` : `${name} billetter`
  );

  return `https://www.google.com/search?q=${q}`;
}

// -------------------------------------------------------
//  DATABASE HELPERS
// -------------------------------------------------------

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

// Enkel HTML-mail
function resetEmailHtml({ resetUrl }) {
  return `
  <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height:1.4;">
    <h2>Nullstill passord</h2>
    <p>Trykk på knappen under for å velge nytt passord. Lenken varer i 1 time.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}"
         style="background:#16a34a;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;display:inline-block;">
        Nullstill passord
      </a>
    </p>
    <p>Hvis du ikke ba om dette, kan du ignorere e-posten.</p>
    <hr/>
    <p style="color:#6b7280;font-size:12px;">Grenseløs Reise</p>
  </div>
  `;
}

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

function sanitizeUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

function extractJson(text) {
  if (!text) return null;

  // Prøv først å parse alt rett fram
  try {
    return JSON.parse(text);
  } catch (e) {
    // Ignorer, prøv neste strategi
  }

  // Hvis KI har returnert ```json ... ```-blokk
  const codeBlockMatch = text.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      return JSON.parse(inner);
    } catch (e) {
      // fortsatt feil, prøv siste
    }
  }

  // Siste: prøv å finne første {...}-blokk
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (e) {
      // gir opp
    }
  }

  return null;
}

function normalizePackingToFourCategoriesSmart(rawPacking, tripContextText = "") {
  // -------- helpers --------
  const normalizeStr = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[-•\d\)\.]+\s*/, ""); // fjerner bullet/nummering

  const splitToItems = (s) =>
    String(s || "")
      .split(/[\n,]/)
      .map((x) => normalizeStr(x))
      .filter(Boolean);

  // 1) Flat ut til ren liste strings
  let items = [];

  const pushItem = (s) => {
    const t = normalizeStr(s);
    if (!t) return;
    items.push(t);
  };

  if (typeof rawPacking === "string") {
    // JSON-string eller vanlig tekst
    try {
      return normalizePackingToFourCategoriesSmart(JSON.parse(rawPacking), tripContextText);
    } catch {
      splitToItems(rawPacking).forEach(pushItem);
    }
  } else if (Array.isArray(rawPacking)) {
    for (const g of rawPacking) {
      if (typeof g === "string") {
        pushItem(g);
      } else if (g && typeof g === "object") {
        if (Array.isArray(g.items)) g.items.forEach(pushItem);
        else if (typeof g.items === "string") splitToItems(g.items).forEach(pushItem);
      }
    }
  } else if (rawPacking && typeof rawPacking === "object") {
    for (const val of Object.values(rawPacking)) {
      if (Array.isArray(val)) val.forEach(pushItem);
      else if (typeof val === "string") splitToItems(val).forEach(pushItem);
    }
  }

  // dedupe (case-insensitive)
  const seen = new Set();
  items = items.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 2) Kontekst (varmt/kaldt/strand/tur/regn osv.)
  const ctx = (tripContextText || "").toLowerCase();
  const isBeach = /strand|bade|snorkl|dykk|kyst|hav|surf/.test(ctx);
  const isHike = /tur|fottur|fjell|trek|stier|vandring/.test(ctx);
  const isRainy = /regn|monsun|tropisk|våt|skurer/.test(ctx);
  const isCold  = /kald|vinter|snø|frost|sibir|arktisk/.test(ctx);
  const isHot   = /varm|hete|tropisk|sol|sør|ørken/.test(ctx);

  // 3) Klassifisering med litt mer presisjon + prioritet
  const buckets = { "Klær": [], "Toalettsaker": [], "Elektronikk": [], "Annet": [] };

  const hasAny = (t, words) => words.some((w) => t.includes(w));

  const isElectronics = (t) =>
    hasAny(t, [
      "lader","kabel","adapter","powerbank","mobil","telefon","iphone","android",
      "kamera","gopro","drone","hodetelefon","airpods","pc","laptop","mac","ipad",
      "nettbrett","minnekort","batteri","usb","strøm"
    ]);

  const isToiletries = (t) =>
    hasAny(t, [
      "tannbørste","tannkrem","tann","deodor","sjampo","shampoo","balsam","såpe",
      "hudkrem","fukt","barber","sminke","linser","kontaktlinser","medisin",
      "plaster","førstehjelp","mygg","insekt","hånddesinf","solkrem","after sun"
    ]);

  const isClothes = (t) =>
    hasAny(t, [
      "t-skjorte","skjorte","genser","bukse","shorts","undertøy","sok","jakke",
      "regnjakke","vindjakke","sko","joggesko","fjellsko","sandaler",
      "caps","hatt","lue","votter","buff","badetøy","bikini","badebukse"
    ]);

  const isDocsMoney = (t) =>
    hasAny(t, ["pass","id","førerkort","reiseforsikring","forsikring","kontanter","kort","visa"]);

  const isGear = (t) =>
    hasAny(t, [
      "dagstursekk","ryggsekk","sekk","vannflaske","drikkeflaske","hodelykt",
      "kniv","multiverktøy","kart","kompass","pakkpose","vanntett pose","poncho",
      "myggnett","telt","sovepose"
    ]);

  // 3b) “Tvetydige” items justeres av kontekst
  // - solkrem: Toalettsaker (alltid)
  // - badetøy: Klær (men bare hvis strand/varmt, ellers nedprioriter)
  // - fottøy for fotturer: Klær
  // - regnjakke/poncho: Klær/Annet (vi velger Klær)
  // - kamera: Elektronikk (alltid)
  // - førstehjelp: Toalettsaker

  for (const item of items) {
    const t = item.toLowerCase();

    // Prioritet: Dokumenter/”må-ha” -> Annet
    if (isDocsMoney(t)) {
      buckets["Annet"].push(item);
      continue;
    }

    // Elektronikk
    if (isElectronics(t)) {
      buckets["Elektronikk"].push(item);
      continue;
    }

    // Toalettsaker
    if (isToiletries(t)) {
      buckets["Toalettsaker"].push(item);
      continue;
    }

    // Klær
    if (isClothes(t)) {
      // Hvis “badetøy” men reisen ikke virker strand/varm -> putt i Annet (valgfritt)
      if (hasAny(t, ["badetøy","bikini","badebukse"]) && !(isBeach || isHot)) {
        buckets["Annet"].push(item);
      } else {
        buckets["Klær"].push(item);
      }
      continue;
    }

    // Utstyr/gear
    if (isGear(t)) {
      // tur/trek -> ofte “Annet”
      buckets["Annet"].push(item);
      continue;
    }

    // fallback
    buckets["Annet"].push(item);
  }

  // 4) Kontekstbaserte “must-have” dersom mangler
  const defaults = {
    "Klær": ["Undertøy", "Sokker", "T-skjorter"],
    "Toalettsaker": ["Tannbørste", "Tannkrem", "Deodorant"],
    "Elektronikk": ["Mobil + lader", "Powerbank", "Hodetelefoner"],
    "Annet": ["Pass/ID-kort", "Reiseforsikring", "Liten dagstursekk"]
  };

  if (isRainy) {
    defaults["Klær"].unshift("Regnjakke");
    defaults["Annet"].unshift("Vanntett pakkpose");
  }
  if (isCold) {
    defaults["Klær"].unshift("Ullundertøy", "Lue og votter");
  }
  if (isBeach || isHot) {
    defaults["Klær"].unshift("Badetøy");
    defaults["Toalettsaker"].unshift("Solkrem");
  }
  if (isHike) {
    defaults["Klær"].unshift("Gode tursko");
    defaults["Annet"].unshift("Vannflaske");
  }

  for (const cat of ["Klær", "Toalettsaker", "Elektronikk", "Annet"]) {
    while (buckets[cat].length < 3) {
      const candidate = defaults[cat][buckets[cat].length] || null;
      if (!candidate) break;
      if (!buckets[cat].some((x) => x.toLowerCase() === candidate.toLowerCase())) {
        buckets[cat].push(candidate);
      } else {
        break;
      }
    }
  }

  // 5) return nøyaktig 4 kategorier i riktig rekkefølge (maks 10 items per kategori)
  return [
    { category: "Klær",        items: buckets["Klær"].slice(0, 10) },
    { category: "Toalettsaker",items: buckets["Toalettsaker"].slice(0, 10) },
    { category: "Elektronikk", items: buckets["Elektronikk"].slice(0, 10) },
    { category: "Annet",       items: buckets["Annet"].slice(0, 10) }
  ];
}

// ---------- helpers: JSON + URL ----------
const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // pg JSONB kan komme som object i enkelte tilfeller – bare avvis alt som ikke er array
  return [];
};

const isHttpUrl = (s) => {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^https?:\/\/\S+/i.test(t);
};

const makeFallbackPlaceUrl = (name, location) => {
  const n = (name || "").toString().trim();
  const loc = (location || "").toString().trim();
  if (!n) return null;
  const q = encodeURIComponent(loc ? `${n} ${loc}` : n);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
};

// Normaliser experiences til { name, description, location, url, day, price }
const normalizeExperiences = (raw) => {
  const arr = parseJsonArray(raw);

  return arr
    .filter((x) => x && typeof x === "object")
    .map((x, i) => {
      const name =
        (x.name || x.title || x.activity || "").toString().trim() ||
        `Opplevelse ${i + 1}`;

      const description = (x.description || "").toString().trim();
      const location = (x.location || x.city || x.area || "").toString().trim();

      const rawUrl =
        (typeof x.url === "string" && x.url.trim()) ||
        (typeof x.booking_url === "string" && x.booking_url.trim()) ||
        (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
        (typeof x.link === "string" && x.link.trim()) ||
        (typeof x.external_url === "string" && x.external_url.trim()) ||
        null;

      const url = rawUrl ? (isHttpUrl(rawUrl) ? rawUrl.trim() : null) : makeFallbackPlaceUrl(name, location);

      const day = typeof x.day === "number" ? x.day : null;
      const price = typeof x.price === "number" ? x.price : null;

      return {
        id: x.id ?? `exp-${i}`,
        name,
        description,
        location,
        url,
        day,
        price
      };
    })
    .filter((e) => e.name);
};

function normalizeTripStructure(parsed) {
  // -------------------------
  // Helpers
  // -------------------------
  const safeStr = (v) =>
    typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();

  const toNumOrNull = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const isHttpUrl = (s) => {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return /^https?:\/\/\S+/i.test(t);
  };

  const parseArrayField = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const p = JSON.parse(value);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  // Booking/ticket fallback (IKKE maps)
  const makeTicketSearchUrl = (title, location) => {
    const t = safeStr(title);
    const loc = safeStr(location);
    if (!t) return null;
    const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
    return `https://www.google.com/search?q=${q}`;
  };

  // -------------------------
  // Guard
  // -------------------------
  if (!parsed || typeof parsed !== "object") {
    return {
      title: "Reiseforslag fra KI",
      description: null,
      stops: [],
      packing_list: normalizePackingToFourCategoriesSmart([], ""),
      hotels: [],
      experiences: []
    };
  }

  // -------------------------
  // Title / description
  // -------------------------
  const title = safeStr(parsed.title) || "Reiseforslag fra KI";
  const description = safeStr(parsed.description) || null;

  // -------------------------
  // STOPS
  // -------------------------
  const rawStops = parseArrayField(parsed.stops);

  const stops = rawStops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => {
      const name = safeStr(s.name || s.title) || `Stopp ${idx + 1}`;
      const desc = safeStr(s.description) || "";

      const lat = toNumOrNull(s.lat ?? s.latitude);
      const lng = toNumOrNull(s.lng ?? s.longitude);

      let day = s.day ?? null;
      day = typeof day === "number" ? day : toNumOrNull(day);
      if (day == null) day = idx + 1;

      const location = safeStr(s.location || s.address || s.subtitle) || null;

      // Hotels pr stop (valgfritt)
      const stopHotels = parseArrayField(s.hotels)
        .filter((h) => h && typeof h === "object")
        .map((h, hi) => {
          const hn = safeStr(h.name || h.title) || `Hotell ${hi + 1}`;
          const hl = safeStr(h.location || h.area || h.city) || null;
          const hd = safeStr(h.description || h.notes) || "";
          const price =
            typeof h.price_per_night === "number"
              ? h.price_per_night
              : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

          const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
          const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

          return { name: hn, location: hl, description: hd, price_per_night: price, url };
        })
        .filter((h) => safeStr(h.name));

      return {
        id: s.id ?? `s-${idx}`,
        day,
        name,
        description: desc,
        location,
        lat,
        lng,
        hotels: stopHotels
      };
    })
    .filter((s) => safeStr(s.name));

  // -------------------------
  // PACKING LIST -> NØYAKTIG 4 kategorier (smart)
  // -------------------------
  const rawPacking =
    parsed.packing_list ||
    parsed.packingList ||
    parsed.packing ||
    [];

  const contextText =
    `${title}\n${description || ""}\n` +
    stops.map((s) => `${safeStr(s.name)} ${safeStr(s.description)}`).join("\n");

  const packing_list = normalizePackingToFourCategoriesSmart(rawPacking, contextText);

  // -------------------------
  // HOTELS (flat) + inkluder evt. hotels fra stops
  // -------------------------
  const rawHotelsCombined = [
    ...(Array.isArray(parsed.hotels) ? parsed.hotels : parseArrayField(parsed.hotels)),
    ...stops.flatMap((s) => (Array.isArray(s.hotels) ? s.hotels : []))
  ];

  const hotels = rawHotelsCombined
    .filter((h) => h && typeof h === "object")
    .map((h, idx) => {
      const name = safeStr(h.name || h.title) || `Hotell ${idx + 1}`;
      const location = safeStr(h.location || h.area || h.city) || null;
      const descriptionH = safeStr(h.description || h.notes) || "";

      const price =
        typeof h.price_per_night === "number"
          ? h.price_per_night
          : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

      const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
      const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

      return {
        id: h.id ?? `h-${idx}`,
        name,
        location,
        description: descriptionH,
        price_per_night: price ?? null,
        url
      };
    })
    .filter((h) => safeStr(h.name));

  // -------------------------
  // EXPERIENCES (ny!)
  // -------------------------
  const rawExperiences =
    parseArrayField(parsed.experiences).length
      ? parseArrayField(parsed.experiences)
      : parseArrayField(parsed.activities || parsed.tickets || parsed.bookings);

  const experiences = rawExperiences
    .filter((x) => x && typeof x === "object")
    .map((x, idx) => {
      const name = safeStr(x.title || x.name || x.activity) || `Opplevelse ${idx + 1}`;
      const location = safeStr(x.location || x.city || x.area) || null;
      const descriptionX = safeStr(x.description) || "";

      const rawUrl = safeStr(
        x.booking_url || x.url || x.ticket_url || x.link || x.external_url
      ) || null;

      const url = rawUrl
        ? (isHttpUrl(rawUrl) ? rawUrl : null)
        : makeTicketSearchUrl(name, location);

      const day =
        typeof x.day === "number" ? x.day : toNumOrNull(x.day);

      const price_per_person =
        typeof x.price_per_person === "number"
          ? x.price_per_person
          : toNumOrNull(x.price_per_person);

      const currency = safeStr(x.currency) || "NOK";

      return {
        id: x.id ?? `exp-${idx}`,
        name,
        location,
        description: descriptionX,
        url,
        day: day ?? null,
        price_per_person: price_per_person ?? null,
        currency
      };
    })
    .filter((e) => safeStr(e.name));

  return {
    title,
    description,
    stops,
    packing_list,
    hotels,
    experiences
  };
}

// Bruk KI til å gjette hovedland for en reise ut fra tittel/beskrivelse/stopp
async function inferCountryForTrip(trip) {
  if (!trip) return null;

  // 1) Normaliser stops
  let stops = trip.stops;
  if (typeof stops === 'string') {
    try {
      stops = JSON.parse(stops);
    } catch {
      stops = [];
    }
  }
  if (!Array.isArray(stops)) stops = [];

  // 2) Samle all tekst vi har om reisen
  const parts = [];

  if (trip.title) parts.push(String(trip.title));
  if (trip.description) parts.push(String(trip.description));

  for (const s of stops) {
    if (!s || typeof s !== 'object') continue;
    if (s.name) parts.push(String(s.name));
    if (s.description) parts.push(String(s.description));
  }

  if (parts.length === 0) {
    return null;
  }

  const travelText = parts.join('\n\n');

  // 3) Spør KI om land – generisk, funker for Kongo, Japan, hva som helst
  const systemPrompt = `
Du får beskrivelse av en reise (tittel, tekst og stopp).
Din jobb er å svare hvilket land reisen PRIMÆRT handler om.

KRAV:
- Svar KUN med landnavnet på norsk, f.eks. "Italia", "Spania", 
  "Den demokratiske republikken Kongo", "Japan".
- Ikke skriv noe forklaringstekst.
- Hvis du er usikker eller det ikke handler om ett bestemt land, svar "UKJENT".
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: travelText }
    ],
    temperature: 0  // vi vil ha deterministisk svar
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "";
  // Ta første linje, fjern evt. anførselstegn
  const answer = raw.split('\n')[0].replace(/^["']|["']$/g, '').trim();

  if (!answer || /^ukjent$/i.test(answer)) {
    return null;
  }

  return answer; // f.eks. "Kongo", "Italia", "Japan"
}

// Veldig enkel "reiseråd-database" – tilpass/utvid som du vil
function buildGenericTravelAdviceText(countryRaw) {
  const country = countryRaw ? String(countryRaw).trim() : null;

  if (!country) {
    return (
      'Fant ikke noe tydelig land for denne reisen.\n\n' +
      'For oppdaterte offisielle reiseråd, se Utenriksdepartementets sider ' +
      'for reiseinformasjon der du søker opp landet du skal til.'
    );
  }
    
  const lower = country.toLowerCase();

  if (['italia', 'italy'].includes(lower)) {
    return (
      'Reiseråd for Italia (ikke offisielt, kun veiledende):\n\n' +
      '• Sjekk alltid gyldig pass/ID-kort og at reiseforsikring dekker hele perioden.\n' +
      '• Vær oppmerksom på lommetyveri i turistområder (Roma, Napoli, Firenze, Venezia osv.).\n' +
      '• Følg lokale regler for trafikk, parkering og bruk av offentlig transport.\n' +
      '• I perioder med ekstrem varme kan det være fare for skogbranner – følg lokale varsler.\n\n' +
      'For offisielle og oppdaterte reiseråd, se Utenriksdepartementets reiseinformasjon ' +
      'for Italia på regjeringen.no eller UD-appen.'
    );
  }

  if (['norge', 'norway'].includes(lower)) {
    return (
      'Reiseråd for reiser i Norge (ikke offisielt, kun veiledende):\n\n' +
      '• Værforhold kan endre seg raskt – spesielt i fjellet. Sjekk værvarsel og lokale forhold.\n' +
      '• Følg lokale råd og varsler om rasfare, flom og skred.\n' +
      '• Ta hensyn til ferdselsregler i verneområder og på privat eiendom.\n\n' +
      'For offisielle og oppdaterte råd, se informasjon fra lokale myndigheter, ' +
      'Statens vegvesen og varslingstjenester (f.eks. varsom.no).'
    );
  }

  // fallback for alle andre land
  return (
    `Reiseråd for ${country} (ikke offisielt, kun veiledende):\n\n` +
    '• Sjekk alltid offisielle reiseråd før avreise – spesielt når det gjelder sikkerhet, ' +
    'politisk situasjon, helse og innreiseregler.\n' +
    '• Sørg for gyldig reiseforsikring som dekker sykdom, ulykke og hjemtransport.\n' +
    '• Kontroller pass/visum-krav og eventuelle krav til vaksiner.\n\n' +
    'For offisielle, oppdaterte reiseråd, se Utenriksdepartementets reiseinformasjon ' +
    'for landet på regjeringen.no eller i UD-appen.'
  );
}

// KI-basert reiseråd for et vilkårlig land
async function buildTravelAdviceText(countryRaw) {
  const country = countryRaw ? String(countryRaw).trim() : null;

  if (!country) {
    // ingen land – bruk generisk tekst
    return buildGenericTravelAdviceText(null);
  }

  try {
    const systemPrompt = `
Du gir uoffisielle, generelle reiseråd på norsk for folk som skal til et bestemt land.

KRAV:
- Svar på norsk.
- Svar KUN med ren tekst, ingen JSON.
- Start med en kort overskrift på formen:
  "Reiseråd for <LAND> (ikke offisielt, kun veiledende)"
- Deretter 5–8 konkrete punkter i punktliste (bruk "• " i starten av linjen).
- Ta opp typiske forhold som:
  - sikkerhet/kriminalitet
  - politisk situasjon/uro hvis relevant
  - helse / vaksiner / malaria osv. hvis relevant
  - klima / naturfarer (f.eks. flom, skogbrann, orkan, jordskjelv)
  - praktiske ting (innreise, transport, lokale lover/normer)
- Avslutt med en setning om at brukeren alltid må sjekke offisielle reiseråd fra Utenriksdepartementet før avreise.
- Ikke skriv lenker, bare henvis generelt til UD / regjeringen.no.
`.trim();

    const userPrompt = `
Land: ${country}

Gi kortfattede, konkrete reiseråd for dette landet.
`.trim();

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4
    });

    const text =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (!text) {
      // fallback til hardkodet hvis KI-responsen er tom
      return buildGenericTravelAdviceText(country);
    }

    return text;
  } catch (e) {
    console.error("buildTravelAdviceText (KI) feilet:", e);
    // fallback hvis OpenAI kaster feil
    return buildGenericTravelAdviceText(country);
  }
}

// -------------------------------------------------------
//  AUTH MIDDLEWARE
// -------------------------------------------------------

//async function authMiddleware(req, res, next) {
// const auth = req.headers.authorization || "";
//const parts = auth.split(" ");
//const scheme = (parts[0] || "").trim();
//const token = (parts[1] || "").trim();

  // liten helper for konsistent logging
//const reqMeta = {
//    method: req.method,
//    path: req.originalUrl || req.url,
//    ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
//    ua: req.headers["user-agent"],
//    requestId:
//      req.headers["x-request-id"] ||
//      req.headers["x-amzn-trace-id"] ||
//      req.headers["cf-ray"] ||
//      null,
//  };

//  if (!auth) {
//    console.warn("[auth] Missing Authorization header", reqMeta);
//    return res.status(401).json({ error: "Manglende Authorization header." });
//  }

//  if (scheme.toLowerCase() !== "bearer" || !token) {
//    console.warn("[auth] Malformed Authorization header", {
//      ...reqMeta,
//      scheme: scheme || null,
//      hasToken: !!token,
//      authPrefix: auth.slice(0, 20), // bare litt, ikke hele
//    });
//    return res.status(401).json({ error: "Manglende eller ugyldig Authorization header." });
// }

//  try {
//    // NB: ikke logg tokenet
//    const decoded = jwt.verify(token, JWT_SECRET);

//    if (!decoded?.userId) {
//      console.warn("[auth] Token decoded but missing userId", {
//        ...reqMeta,
//        decodedKeys: Object.keys(decoded || {}),
//      });
//      return res.status(401).json({ error: "Ugyldig token (mangler userId)." });
//    }

//    // Hent bruker fra DB slik at vi alltid har is_admin + navn tilgjengelig
//    const u = await query(
//      `SELECT id, email, full_name, is_admin, is_premium FROM users WHERE id=$1`,
//      [decoded.userId]
//    );

//    if (u.rowCount === 0) {
//      console.warn("[auth] User not found for token userId", {
//        ...reqMeta,
//        userId: decoded.userId,
//      });
//      return res.status(401).json({ error: "Bruker ikke funnet." });
//    }

//    const user = u.rows[0];

//    req.user = {
//      id: user.id,
//      email: user.email,
//      full_name: user.full_name,
//      is_admin: !!user.is_admin,
//      is_premium: !!user.is_premium,
//    };

//    // valgfritt: debug på suksess (kan bli mye støy i prod)
//    // console.log("[auth] OK", { ...reqMeta, userId: user.id, is_admin: !!user.is_admin });

//    next();
//  } catch (err) {
//    const name = err?.name || "Error";
//    const message = err?.message || String(err);

    // Skille typiske JWT-feil
//    const reason =
//      name === "TokenExpiredError"
//        ? "expired"
//        : name === "JsonWebTokenError"
//          ? "invalid"
//          : name === "NotBeforeError"
//            ? "not-active-yet"
//            : "verify-failed";

//    console.warn("[auth] JWT verify failed", {
//      ...reqMeta,
//      reason,
//      jwtErrorName: name,
//      jwtErrorMessage: message,
//    });

//    return res.status(401).json({ error: "Ugyldig eller utløpt token." });
//  }
//}

function canSeeTripDetails(req) {
  return !!(req.user?.is_admin || req.user?.is_premium);
}

// -------------------------------------------------------
//  SJEKK ADMIN
// -------------------------------------------------------

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

// -------------------------------------------------------
//  SPOTIFY HELPERS
// -------------------------------------------------------

async function fetchGrenselosEpisodes() {
  const token = await getSpotifyAccessToken();
  const limit = 50;
  let offset = 0;
  let allItems = [];

  while (true) {
    const url =
      `https://api.spotify.com/v1/shows/${process.env.SPOTIFY_SHOW_ID}/episodes` +
      `?market=NO&limit=${limit}&offset=${offset}`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const items = res.data?.items || [];
    allItems = allItems.concat(items);

    if (items.length < limit) {
      break;
    }

    offset += limit;
  }

  const episodes = allItems.map((ep) => ({
    id: ep.id,
    name: ep.name,
    description: ep.description,
    release_date: ep.release_date,
    image: ep.images?.[0]?.url || null,
    external_url: ep.external_urls?.spotify || null
  }));

  episodes.sort((a, b) => {
    if (!a.release_date || !b.release_date) return 0;
    return new Date(a.release_date) - new Date(b.release_date);
  });

  return episodes;
}

// -------------------------------------------------------
//  KI: GENERISK TRIP GENERATOR (MED PAKKELISTE)
// -------------------------------------------------------

async function generateTripFromAI({ sourceUrl, userDescription, userProfile }) {
  const profileText = userProfile
    ? `
- Navn: ${userProfile.full_name}
- Bosted: ${userProfile.home_city}, ${userProfile.home_country}
- Født: ${userProfile.birth_year}
- Reisestil: ${userProfile.travel_style}
- Budsjett: ${userProfile.budget_per_day}
- Erfaring: ${userProfile.experience_level}
`
    : "Ingen personlig profil tilgjengelig.";

  const budgetPerDay =
    userProfile?.budget_per_day != null && !isNaN(Number(userProfile.budget_per_day))
      ? Number(userProfile.budget_per_day)
      : null;

  // En enkel “pris”-heuristikk
  const defaultHotelPrice = budgetPerDay
    ? Math.max(500, Math.round(budgetPerDay * 0.7))
    : 1200;

  // -------------------------
  // Helpers
  // -------------------------
  const isHttpUrl = (s) => {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return /^https?:\/\/\S+/i.test(t);
  };

  // Ticket/booking fallback (IKKE Google Maps, men søk)
  const makeTicketSearchUrl = (name, location) => {
    const n = (name || "").toString().trim();
    const loc = (location || "").toString().trim();
    if (!n) return null;
    const q = encodeURIComponent(loc ? `${n} ${loc} billetter` : `${n} billetter`);
    return `https://www.google.com/search?q=${q}`;
  };

  const normalizeExperiencesArray = (raw, fallbackLocation = "") => {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((x) => x && typeof x === "object")
      .map((x, i) => {
        const name =
          (typeof x.name === "string" && x.name.trim()) ? x.name.trim()
          : (typeof x.title === "string" && x.title.trim()) ? x.title.trim()
          : (typeof x.activity === "string" && x.activity.trim()) ? x.activity.trim()
          : `Opplevelse ${i + 1}`;

        const description = typeof x.description === "string" ? x.description.trim() : "";
        const location =
          (typeof x.location === "string" && x.location.trim()) ? x.location.trim()
          : (typeof x.city === "string" && x.city.trim()) ? x.city.trim()
          : (typeof x.area === "string" && x.area.trim()) ? x.area.trim()
          : (fallbackLocation || "");

        const rawUrl =
          (typeof x.url === "string" && x.url.trim()) ||
          (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
          (typeof x.booking_url === "string" && x.booking_url.trim()) ||
          (typeof x.link === "string" && x.link.trim()) ||
          (typeof x.external_url === "string" && x.external_url.trim()) ||
          null;

        const url = rawUrl
          ? (isHttpUrl(rawUrl) ? rawUrl.trim() : null)
          : makeTicketSearchUrl(name, location);

        const day = typeof x.day === "number" ? x.day : null;

        const price_per_person =
          typeof x.price_per_person === "number"
            ? x.price_per_person
            : (x.price_per_person != null && !isNaN(Number(x.price_per_person)) ? Number(x.price_per_person) : null);

        const currency =
          typeof x.currency === "string" && x.currency.trim()
            ? x.currency.trim()
            : "NOK";

        return {
          id: x.id ?? `exp-${i}`,
          name,
          description,
          location,
          url,
          day,
          price_per_person,
          currency
        };
      })
      .filter((e) => e.name);
  };

  // -------------------------
  // Prompt
  // -------------------------
  const sysPrompt = `
Du er en reiseplanlegger for appen "Grenseløs Reise".

DU MÅ ALLTID svare med REN JSON (ingen forklaringstekst utenfor JSON).

Struktur:

{
  "trip": {
    "title": "Kort tittel på reisen",
    "description": "Kort intro (2–5 linjer)",
    "stops": [
      {
        "day": 1,
        "name": "Navn på stopp",
        "description": "Kort beskrivelse",
        "lat": null,
        "lng": null,
        "hotels": [
          {
            "name": "Navn på hotell/overnatting",
            "approx_price_per_night": 1200,
            "currency": "NOK",
            "notes": "Kort begrunnelse",
            "url": null
          }
        ],
        "experiences": [
          {
            "name": "Opplevelse/attraksjon",
            "description": "Kort hva/hvorfor",
            "location": "Sted/by/område",
            "day": 1,
            "url": null,
            "price_per_person": null,
            "currency": "NOK"
          }
        ]
      }
    ],
    "experiences": [
      {
        "name": "Opplevelse/attraksjon",
        "description": "Kort hva/hvorfor",
        "location": "Sted/by/område",
        "day": 1,
        "url": null,
        "price_per_person": null,
        "currency": "NOK"
      }
    ],
    "packing_list": ["..."]
  }
}

KRAV FOR STOPS:
- trip.stops SKAL være array med minst 3 stopp hvis mulig.
- Hvert stopp SKAL ha day, name, description.
- lat/lng: bruk null hvis usikker.

KRAV FOR HOTELS:
- Hvert stopp SKAL ha hotels som array.
- hotels SKAL ha 1–3 forslag per stopp (ikke tom).
- name SKAL alltid finnes.
- approx_price_per_night SKAL være et tall.
- currency: bruk "NOK" for norske brukere ellers relevant valuta.
- notes: kort begrunnelse.
- url er VALGFRI: bruk en konkret URL hvis du er sikker, ellers null.
- Ikke bruk Google-søk/Google Maps-søk-URL.

KRAV FOR EXPERIENCES:
- trip.experiences SKAL være en array med 4–10 opplevelser totalt.
- I tillegg KAN du legge 0–3 experiences per stopp (stop.experiences) hvis relevant.
- url: bruk offisiell billett/booking-side hvis du er sikker, ellers null.
- IKKE bruk Google-søk/Google Maps-søk-URL.

KRAV FOR PACKING_LIST:
- packing_list SKAL være array med minst 8–12 konkrete ting.
- Ingen "diverse", "annet", osv.
`;

  const userPrompt = `
Lag et konkret reiseforslag basert på dette:

Brukerens forespørsel:
${userDescription}

Kilde-URL (kan være null):
${sourceUrl || "ingen"}

Brukerprofil:
${profileText}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userPrompt }
    ],
    max_output_tokens: 1800
  });

  const raw = response.output_text || "{}";
  console.log("🧾 Rått KI-svar (før parsing):", raw);

  let jsonText = raw.trim();

  // Stripp ```json``` blokker
  if (jsonText.startsWith("```")) {
    const lines = jsonText.split("\n");
    lines.shift();
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    jsonText = lines.join("\n").trim();
  }

  // Ta ut substring mellom første { og siste }
  if (!(jsonText.startsWith("{") && jsonText.endsWith("}"))) {
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error("❌ Klarte ikke å parse KI-svar som JSON:", e);
    console.error("📄 Innhold som feilet parsing:", jsonText);
    return {
      trip: { title: "Reiseforslag", description: null, stops: [], packing_list: [], experiences: [] }
    };
  }

  // -------------------------
  // Defensiv normalisering
  // -------------------------
  if (!parsed.trip || typeof parsed.trip !== "object") parsed.trip = {};
  if (!Array.isArray(parsed.trip.stops)) parsed.trip.stops = [];
  if (!Array.isArray(parsed.trip.packing_list)) parsed.trip.packing_list = [];
  if (!Array.isArray(parsed.trip.experiences)) parsed.trip.experiences = [];

  // ✅ Normaliser stops + sørg for hotels per stop
  parsed.trip.stops = parsed.trip.stops.map((stop, idx) => {
    const s = stop && typeof stop === "object" ? stop : {};
    let hotels = Array.isArray(s.hotels) ? s.hotels : [];

    hotels = hotels
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        name: typeof h.name === "string" ? h.name.trim() : "",
        approx_price_per_night:
          typeof h.approx_price_per_night === "number"
            ? h.approx_price_per_night
            : Number(h.approx_price_per_night) || defaultHotelPrice,
        currency: typeof h.currency === "string" ? h.currency.trim() : "NOK",
        notes: typeof h.notes === "string" ? h.notes.trim() : "",
        url: typeof h.url === "string" && h.url.trim() ? h.url.trim() : null
      }))
      .filter((h) => h.name);

    if (hotels.length === 0) {
      const place =
        (typeof s.name === "string" && s.name.trim()) ? s.name.trim() : `Stopp ${idx + 1}`;
      hotels = [
        {
          name: `Budsjett-hotell i ${place}`,
          approx_price_per_night: defaultHotelPrice,
          currency: "NOK",
          notes: "Forslag generert uten sikker lenke – velg etter beliggenhet og omtaler.",
          url: null
        },
        {
          name: `Sentral overnatting i ${place}`,
          approx_price_per_night: Math.round(defaultHotelPrice * 1.2),
          currency: "NOK",
          notes: "Et alternativ nær sentrum/transport – sjekk tilgjengelighet i app/booking.",
          url: null
        }
      ];
    }

    // ✅ Normaliser stop.experiences (valgfritt felt)
    const stopLocation =
      (typeof s.name === "string" && s.name.trim()) ? s.name.trim() : "";
    const stopExperiences = normalizeExperiencesArray(s.experiences, stopLocation);

    return { ...s, hotels, experiences: stopExperiences };
  });

  // ✅ Normaliser trip.experiences
  let tripExperiences = normalizeExperiencesArray(parsed.trip.experiences, "");

  // ✅ Hvis modellen la experiences på stopp men ikke på trip → løft opp til trip
  if (tripExperiences.length === 0) {
    const lifted = [];
    for (const s of parsed.trip.stops) {
      if (Array.isArray(s.experiences)) {
        for (const e of s.experiences) lifted.push(e);
      }
    }
    tripExperiences = lifted.slice(0, 12);
  }

  // ✅ Hvis fortsatt tomt: legg inn en liten fallback-liste basert på stoppnavn
  if (tripExperiences.length === 0 && parsed.trip.stops.length > 0) {
    const firstStopName = (parsed.trip.stops[0]?.name || "").toString().trim();
    tripExperiences = [
      {
        id: "exp-fallback-1",
        name: "Guidet opplevelse / byvandring",
        description: "Sjekk tilgjengelige turer og billetter i området.",
        location: firstStopName || "",
        url: makeTicketSearchUrl("Guidet tur", firstStopName || ""),
        day: 1,
        price_per_person: null,
        currency: "NOK"
      },
      {
        id: "exp-fallback-2",
        name: "Museum / attraksjon",
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        location: firstStopName || "",
        url: makeTicketSearchUrl("Museum", firstStopName || ""),
        day: 1,
        price_per_person: null,
        currency: "NOK"
      }
    ];
  }

  parsed.trip.experiences = tripExperiences;

  return parsed;
}

// -------------------------------------------------------
//  KI: EPISODE-BASERT TRIP (PERSONLIG + TILPASNING)
//  - Oppdatert: mer spesifikk pakkeliste basert på episode/Johnny/sted
// -------------------------------------------------------
async function generateTripFromEpisode({
  episodeId,
  name,
  description,
  userPreferences,
  userProfile
}) {
  const profileText = userProfile
    ? `
- Navn: ${userProfile.full_name || ""}
- Bosted: ${userProfile.home_city || ""}, ${userProfile.home_country || ""}
- Født: ${userProfile.birth_year || ""}
- Reisestil: ${userProfile.travel_style || ""}
- Budsjett per dag: ${userProfile.budget_per_day || ""}
- Erfaring: ${userProfile.experience_level || ""}
`.trim()
    : "Ingen personlig profil tilgjengelig.";

  // -------------------------
  // Helpers
  // -------------------------
  const isHttpUrl = (s) => {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return /^https?:\/\/\S+/i.test(t);
  };

  // Ticket/booking fallback (IKKE Google Maps)
  const makeTicketSearchUrl = (title, location) => {
    const t = (title || "").toString().trim();
    const loc = (location || "").toString().trim();
    if (!t) return null;
    const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
    return `https://www.google.com/search?q=${q}`;
  };

  const normalizeExperiencesArray = (raw) => {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((x) => x && typeof x === "object")
      .map((x, i) => {
        const name =
          (typeof x.name === "string" && x.name.trim()) ? x.name.trim()
          : (typeof x.title === "string" && x.title.trim()) ? x.title.trim()
          : (typeof x.activity === "string" && x.activity.trim()) ? x.activity.trim()
          : `Opplevelse ${i + 1}`;

        const location =
          (typeof x.location === "string" && x.location.trim()) ? x.location.trim()
          : (typeof x.city === "string" && x.city.trim()) ? x.city.trim()
          : (typeof x.area === "string" && x.area.trim()) ? x.area.trim()
          : "";

        const description =
          (typeof x.description === "string" && x.description.trim()) ? x.description.trim()
          : "";

        const rawUrl =
          (typeof x.url === "string" && x.url.trim()) ||
          (typeof x.booking_url === "string" && x.booking_url.trim()) ||
          (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
          (typeof x.link === "string" && x.link.trim()) ||
          (typeof x.external_url === "string" && x.external_url.trim()) ||
          null;

        // Kun behold hvis den er en ekte http(s)-url. Ellers null (ikke google-søk her).
        const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl.trim() : null;

        const day = typeof x.day === "number" ? x.day : null;

        const price_per_person =
          typeof x.price_per_person === "number"
            ? x.price_per_person
            : (x.price_per_person != null && !isNaN(Number(x.price_per_person)) ? Number(x.price_per_person) : null);

        const currency =
          typeof x.currency === "string" && x.currency.trim()
            ? x.currency.trim()
            : "NOK";

        return {
          id: x.id ?? `exp-${episodeId || "ep"}-${i}`,
          name,
          location,
          description,
          url,
          day,
          price_per_person,
          currency
        };
      })
      .filter((e) => e.name);
  };

  function cleanEpisodeDescription(text) {
    const s = (text || "").toString();

    // Fjern typiske Acast/annonse-linjer
    const lines = s.split("\n").map(l => l.trim());
    const filtered = lines.filter(l => {
      const low = l.toLowerCase();
      if (!l) return false;
      if (low.includes("vil du annonsere")) return false;
      if (low.includes("hosted on acast")) return false;
      if (low.includes("acast.com/privacy")) return false;
      if (low.includes("ta kontakt med vår salgspartner")) return false;
      if (low.includes("send epost til")) return false;
      return true;
    });

    return filtered.join("\n").trim();
}
    
    const cleanedDescription = cleanEpisodeDescription(description);
    
  // -------------------------
  // Prompt (oppdatert)
  // -------------------------
  const systemPrompt = `
Du er en erfaren ekspedisjons- og reiseplanlegger for podkasten Grenseløs.
Du lager konkrete reiseforslag basert på episodebeskrivelsen (og implisitte detaljer i den),
samt brukerens ønsker og profil.

Du MÅ ALLTID svare med gyldig JSON, uten forklaringstekst rundt.

Returner strukturert JSON med “title”, “description”, “stops”, “packing_list”, “hotels” og “experiences”.

“experiences” er en array av opplevelser/aktiviteter.
Hver experience må ha: title, location, description, og booking_url (kun hvis du er 100% sikker), ellers null.

OUTPUT-FORMAT (MÅ MATCHES NØYAKTIG):

{
  "title": "Kort og konkret tittel på reisen",
  "description": "Kort intro til reisen (2–5 setninger).",
  "stops": [
    {
      "day": 1,
      "name": "Stedsnavn",
      "description": "Hva gjør man denne dagen, konkrete forslag.",
      "lat": 40.8518,
      "lng": 14.2681
    }
  ],
  "packing_list": [
    {
      "category": "Klær",
      "items": [ "Vind- og regnjakke (pga vær/terreng)", "Gode fjellsko (stein/sti)" ]
    },
    {
      "category": "Toalettsaker",
      "items": [ "Våtsservietter (dårlig tilgang på vann)", "Myggmiddel (hvis relevant)" ]
    },
    {
      "category": "Elektronikk",
      "items": [ "Offline-kart (dekning ustabil)", "Powerbank 20 000 mAh (lange dager)" ]
    },
    {
      "category": "Annet",
      "items": [ "Vannfilter (nevnt/anbefalt av Johnny eller typisk for turen)", "Førstehjelpspakke (kutt/gnagsår)" ]
    }
  ],
  "hotels": [
    {
      "name": "Eksempel Hotel",
      "location": "By / område",
      "description": "Kort hvorfor dette passer til turen.",
      "price_per_night": 1200,
      "url": null
    }
  ],
  "experiences": [
    {
      "title": "Opplevelse/attraksjon",
      "location": "By / område",
      "description": "Kort hvorfor, hva man gjør, og hvorfor verdt det.",
      "booking_url": null,
      "day": 1
    }
  ]
}

KRAV FOR PACKING_LIST (VIKTIG – SKAL VÆRE SPESIFIKK):
- "packing_list" SKAL ALLTID være en liste med NØYAKTIG 4 elementer.
- De 4 elementene SKAL ha "category" lik:
    1) "Klær"
    2) "Toalettsaker"
    3) "Elektronikk"
    4) "Annet"
- Kategorinavnene må være akkurat disse.
- Hver kategori SKAL ha 6–10 items (ikke færre).
- Hvert item SKAL være konkret og situasjonsbestemt, og bør inneholde en kort parentesforklaring
  som knytter det til episoden/Johnny-reisetips/typiske forhold på stedet.
  Eksempel: "Vanntett pakkpose 10L (Johnny: alt må tåle vann)".
- Hvis episodebeskrivelsen antyder klima/terreng (kulde, regn, varme, høyde, ørken, jungel, båt, motorsykkel, safari, by, langtransport),
  må pakkelisten reflektere dette med riktig utstyr (lag-på-lag, sol, mygg, støv, vann, høyde, sikkerhet, etc.).
- Hvis Johnny nevner eller sannsynligvis anbefaler spesifikt utstyr (typisk Grenseløs),
  må du prioritere:
  1) utstyr til trygg ferdsel (fottøy, hodelykt, førstehjelp, kart/kompass/offline kart),
  2) vær/eksponering (regn, vind, sol, kulde),
  3) logistikk (vann, mat, hygieneløsninger),
  4) dokumenter/økonomi (ID, forsikring, betalingsmidler),
  5) opptak/foto hvis relevant (ekstra batteri, minnekort).
- Du må IKKE finne på ville detaljer. Dersom episoden ikke eksplisitt sier f.eks. "jungel", "arktisk", osv.,
  bruk konservative antagelser basert på stedsnavn og beskrivelse. Men pakkelisten skal fortsatt være konkret.

KRAV FOR STOPS:
- 5–10 stopp.
- Hvert stopp SKAL ha "day", "name" og "description".
- Hvis du ikke vet koordinater, sett "lat" og "lng" til null.

KRAV FOR HOTELS:
- 2–6 forslag totalt.
- Hvert hotell SKAL ha "name".
- "price_per_night" skal være et tall (omtrentlig pris per natt) i NOK hvis naturlig, ellers null.

KRAV FOR EXPERIENCES:
- 4–10 experiences totalt.
- booking_url: kun hvis du er sikker på OFFISIELL billett/booking-side, ellers null.
`.trim();

  const userPrompt = `
GRUNNLAG: Grenseløs-episode

- Episode-ID: ${episodeId}
- Tittel: ${name}
- Beskrivelse:
${description}

BRUKERENS TILPASNING/ØNSKER:
${userPreferences && userPreferences.trim()
  ? userPreferences.trim()
  : "Ingen spesifikke ønsker – lag et balansert forslag."}

BRUKERPROFIL (hvis tilgjengelig):
${profileText}

VIKTIG FOR PACKING_LIST:
- Lag pakkelisten som om du skal gi rådene direkte til en lytter av Grenseløs.
- Bruk det som fremgår/antydes i beskrivelsen til å gjøre listen sted- og turspesifikk.
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    // Lavere temp gir ofte bedre "krav-tro" JSON når vi er strenge på format.
    temperature: 0.4
  });

  const aiText = completion.choices?.[0]?.message?.content?.trim() || "";
  const parsed = extractJson(aiText);

  let trip;
  if (parsed && typeof parsed === "object") {
    trip = normalizeTripStructure(parsed);
  } else {
    trip = {
      title: name || "Reiseforslag fra episode",
      description: description || null,
      stops: [],
      packing_list: [],
      hotels: [],
      experiences: []
    };
  }

  // ✅ Experiences: normaliser (ingen google-søk fallback her – håndteres i VirtualTripScreen)
  const rawExperiences =
    Array.isArray(trip.experiences) ? trip.experiences :
    Array.isArray(parsed?.experiences) ? parsed.experiences :
    [];

  trip.experiences = normalizeExperiencesArray(rawExperiences);

  // ✅ Hvis modellen ga 0 experiences, legg inn en liten fallback uten url
  if (trip.experiences.length === 0) {
    const firstStop = Array.isArray(trip.stops) && trip.stops[0] ? trip.stops[0] : null;
    const loc = (firstStop?.name || "").toString().trim();
    trip.experiences = [
      {
        id: `exp-${episodeId}-fallback-1`,
        name: "Guidet opplevelse / byvandring",
        location: loc,
        description: "Sjekk tilgjengelige turer og billetter i området.",
        url: null,
        day: typeof firstStop?.day === "number" ? firstStop.day : 1,
        price_per_person: null,
        currency: "NOK"
      },
      {
        id: `exp-${episodeId}-fallback-2`,
        name: "Museum / attraksjon",
        location: loc,
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        url: null,
        day: typeof firstStop?.day === "number" ? firstStop.day : 1,
        price_per_person: null,
        currency: "NOK"
      }
    ];
  }

  return { trip, raw: aiText };
}

// -------------------------------------------------------
//  AUTO-GENERERE TRIPS FOR EPISODER (SYSTEM-TRIPS)
//  - Oppretter 1 canonical system-trip per episode per bruker
//  - Lagrer stops + hotels + packing_list + experiences + gallery
//  - Geokoder stop-lat/lng via Mapbox hvis MAPBOX_TOKEN finnes
// -------------------------------------------------------
async function ensureTripForEpisode(episode, userId) {
  if (!episode?.id) throw new Error("ensureTripForEpisode: episode.id mangler");
  if (!userId) throw new Error("ensureTripForEpisode: userId mangler");

  // 1) Gjenbruk eksisterende system-trip
  const existing = await query(
    `
      SELECT id, created_at
      FROM trips
      WHERE source_episode_id = $1
        AND user_id = $2
        AND source_type = 'grenselos_episode'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [episode.id, userId]
  );

  if (existing.rowCount > 0) {
    console.log(
      "[ensureTripForEpisode] Gjenbruker system-trip for episode",
      episode.id,
      "trip_id =",
      existing.rows[0].id
    );
    return existing.rows[0].id;
  }

  // ---------------- helpers ----------------
  const toNumOrNull = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const isHttpUrl = (s) => {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return /^https?:\/\/\S+/i.test(t);
  };

  // Ticket/booking fallback (IKKE maps)
  const makeTicketSearchUrl = (title, location) => {
    const t = (title || "").toString().trim();
    const loc = (location || "").toString().trim();
    if (!t) return null;
    const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
    return `https://www.google.com/search?q=${q}`;
  };

  // Geocoding via Mapbox (valgfritt)
  async function geocodePlaceMapbox(queryText) {
    const token = process.env.MAPBOX_TOKEN;
    if (!token) return null;

    const q = String(queryText || "").trim();
    if (!q) return null;

    const url =
      "https://api.mapbox.com/geocoding/v5/mapbox.places/" +
      encodeURIComponent(q) +
      ".json";

    try {
      const r = await axios.get(url, {
        params: { limit: 1, access_token: token }
      });

      const f = r.data?.features?.[0];
      if (!f?.center || f.center.length < 2) return null;

      return { lng: f.center[0], lat: f.center[1] };
    } catch (e) {
      console.warn("[geocodePlaceMapbox] feilet:", e?.response?.status || "", e?.message || e);
      return null;
    }
  }

  // Normaliser experiences til app-format
  const normalizeExperience = (x, fallbackLocation = null) => {
    if (!x || typeof x !== "object") return null;

    const name =
      (typeof x.name === "string" && x.name.trim()) ? x.name.trim() :
      (typeof x.title === "string" && x.title.trim()) ? x.title.trim() :
      (typeof x.activity === "string" && x.activity.trim()) ? x.activity.trim() :
      null;

    if (!name) return null;

    const location =
      (typeof x.location === "string" && x.location.trim()) ? x.location.trim() :
      (typeof x.city === "string" && x.city.trim()) ? x.city.trim() :
      (typeof x.area === "string" && x.area.trim()) ? x.area.trim() :
      (fallbackLocation || null);

    const description = (typeof x.description === "string" ? x.description.trim() : "") || null;

    const rawUrl =
      (typeof x.url === "string" && x.url.trim()) ||
      (typeof x.booking_url === "string" && x.booking_url.trim()) ||
      (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
      (typeof x.link === "string" && x.link.trim()) ||
      (typeof x.external_url === "string" && x.external_url.trim()) ||
      null;

    const url = rawUrl
      ? (isHttpUrl(rawUrl) ? rawUrl.trim() : null)
      : makeTicketSearchUrl(name, location || "");

    const day = typeof x.day === "number" ? x.day : toNumOrNull(x.day);

    const price_per_person =
      typeof x.price_per_person === "number"
        ? x.price_per_person
        : toNumOrNull(x.price_per_person);

    const currency =
      (typeof x.currency === "string" && x.currency.trim()) ? x.currency.trim() : "NOK";

    return {
      name,
      location,
      description,
      url,
      day: day ?? null,
      price_per_person: price_per_person ?? null,
      currency
    };
  };

  // ---------------- 2) Generer ny system-trip fra AI ----------------
  const ai = await generateTripFromAI({
    sourceUrl: episode.external_url,
    userDescription: `Lag en reise basert på Grenseløs-episoden: ${episode.name}`,
    userProfile: null
  });

  const trip = ai?.trip && typeof ai.trip === "object" ? ai.trip : {};

  let stops = Array.isArray(trip.stops) ? trip.stops : [];
  let packingList = Array.isArray(trip.packing_list) ? trip.packing_list : [];
  const tripLevelExperiences = Array.isArray(trip.experiences) ? trip.experiences : [];

  // ---------------- 3) Normaliser stops + day + lat/lng ----------------
  stops = stops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => {
      const dayRaw = s.day ?? (idx + 1);
      const day = typeof dayRaw === "number" ? dayRaw : (toNumOrNull(dayRaw) ?? (idx + 1));

      const name = (typeof s.name === "string" && s.name.trim())
        ? s.name.trim()
        : `Stopp ${idx + 1}`;

      const location =
        (typeof s.location === "string" && s.location.trim()) ? s.location.trim() :
        (typeof s.address === "string" && s.address.trim()) ? s.address.trim() :
        null;

      const lat = toNumOrNull(s.lat ?? s.latitude);
      const lng = toNumOrNull(s.lng ?? s.longitude);

      // Behold ev. hotels / experiences på stopp
      const stopHotels = Array.isArray(s.hotels) ? s.hotels : [];
      const stopExperiences = Array.isArray(s.experiences) ? s.experiences : [];

      return {
        ...s,
        day,
        name,
        location,
        lat: lat ?? null,
        lng: lng ?? null,
        hotels: stopHotels,
        experiences: stopExperiences
      };
    });

  // Geokode manglende koordinater (hvis MAPBOX_TOKEN finnes)
  if (process.env.MAPBOX_TOKEN) {
    for (const s of stops) {
      const has = typeof s.lat === "number" && typeof s.lng === "number";
      if (has) continue;

      const q = [s.name, s.location, trip.title].filter(Boolean).join(", ");
      const hit = await geocodePlaceMapbox(q);

      if (hit) {
        s.lat = hit.lat;
        s.lng = hit.lng;
      }
    }
  }

  // ---------------- 4) Flat ut HOTELS fra hvert stopp ----------------
  // En enkel “pris”-heuristikk lik i generateTripFromAI
  const defaultHotelPrice = 1200;

  const hotels = [];
  for (const s of stops) {
    if (!s || typeof s !== "object") continue;
    if (!Array.isArray(s.hotels)) continue;

    for (const h of s.hotels) {
      if (!h || typeof h !== "object") continue;

      let price = h.approx_price_per_night ?? h.price_per_night ?? null;
      price = toNumOrNull(price);

      const name =
        (typeof h.name === "string" && h.name.trim()) ? h.name.trim() :
        (typeof h.title === "string" && h.title.trim()) ? h.title.trim() :
        "Hotell/overnatting";

      const rawUrl =
        (typeof h.url === "string" && h.url.trim()) ||
        (typeof h.booking_url === "string" && h.booking_url.trim()) ||
        (typeof h.link === "string" && h.link.trim()) ||
        (typeof h.external_url === "string" && h.external_url.trim()) ||
        null;

      const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl.trim() : null;

      hotels.push({
        name,
        location: s.name || null,
        description: (h.notes || h.description || null),
        price_per_night: price ?? defaultHotelPrice,
        url
      });
    }
  }

  // Hvis KI ga 0 hoteller totalt, legg inn minimale fallback-hoteller
  if (hotels.length === 0 && stops.length > 0) {
    const first = stops[0]?.name || "første stopp";
    hotels.push(
      {
        name: `Budsjett-hotell i ${first}`,
        location: first,
        description: "Forslag generert uten sikker lenke – velg etter beliggenhet og omtaler.",
        price_per_night: defaultHotelPrice,
        url: null
      },
      {
        name: `Sentral overnatting i ${first}`,
        location: first,
        description: "Et alternativ nær sentrum/transport – sjekk tilgjengelighet i booking.",
        price_per_night: Math.round(defaultHotelPrice * 1.2),
        url: null
      }
    );
  }

  // ---------------- 5) Samle EXPERIENCES (trip + per stop) ----------------
  const experiences = [];

  // trip-level
  for (const x of tripLevelExperiences) {
    const e = normalizeExperience(x, null);
    if (e) experiences.push(e);
  }

  // stop-level
  for (const s of stops) {
    if (!Array.isArray(s.experiences)) continue;
    for (const x of s.experiences) {
      const e = normalizeExperience(x, s.name || null);
      if (e) {
        // hvis day mangler, bruk stop-day
        if (e.day == null && typeof s.day === "number") e.day = s.day;
        experiences.push(e);
      }
    }
  }

  // Hvis fortsatt tomt: fallback
  if (experiences.length === 0) {
    const loc = stops[0]?.name || "";
    experiences.push(
      {
        name: "Guidet opplevelse / byvandring",
        location: loc || null,
        description: "Sjekk tilgjengelige turer og billetter i området.",
        url: makeTicketSearchUrl("Guidet tur", loc),
        day: stops[0]?.day ?? 1,
        price_per_person: null,
        currency: "NOK"
      },
      {
        name: "Museum / attraksjon",
        location: loc || null,
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        url: makeTicketSearchUrl("Museum", loc),
        day: stops[0]?.day ?? 1,
        price_per_person: null,
        currency: "NOK"
      }
    );
  }

  // Dedup experiences (name+location+day)
  const seenExp = new Set();
  const dedupedExperiences = [];
  for (const e of experiences) {
    const key = `${(e.name || "").toLowerCase()}|${(e.location || "").toLowerCase()}|${e.day ?? ""}`;
    if (seenExp.has(key)) continue;
    seenExp.add(key);
    dedupedExperiences.push(e);
  }

  // ---------------- 6) INSERT system-trip ----------------
  const insert = await query(
    `
      INSERT INTO trips (
        user_id,
        title,
        description,
        stops,
        packing_list,
        hotels,
        experiences,
        source_type,
        source_episode_id,
        gallery,
        episode_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'grenselos_episode',$8,$9,$10)
      RETURNING id
    `,
    [
      userId,
      trip.title || episode.name,
      trip.description || episode.description || null,
      JSON.stringify(stops),
      JSON.stringify(packingList),
      JSON.stringify(hotels),
      JSON.stringify(dedupedExperiences),
      episode.id,
      JSON.stringify([]), // galleri fylles via admin-endepunktene
      episode.external_url || null
    ]
  );

  console.log(
    "[ensureTripForEpisode] Opprettet NY system-trip for episode",
    episode.id,
    "trip_id =",
    insert.rows[0].id,
    "stops:",
    stops.length,
    "hotels:",
    hotels.length,
    "experiences:",
    dedupedExperiences.length
  );

  return insert.rows[0].id;
}

async function getUserTripStats(userId) {
  const userRes = await query(
    `SELECT is_premium, free_trip_limit, is_admin FROM users WHERE id=$1`,
    [userId]
  );

  if (userRes.rowCount === 0) {
    throw new Error("Bruker ikke funnet i getUserTripStats");
  }

  const user = userRes.rows[0];

  const tripsRes = await query(
    `
      SELECT COUNT(*) AS count
      FROM trips
      WHERE user_id = $1
    `,
    [userId]
  );

  const count = Number(tripsRes.rows[0].count || 0);
  const limit = user.free_trip_limit ?? 5;

  return {
    isPremium: !!user.is_premium,
    isAdmin:   !!user.is_admin,   // 👈 NYTT
    tripCount: count,
    freeLimit: limit
  };
}

// -------------------------------------------------------
//  HEALTH CHECK
// -------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------------------------------------------------------
//  DEBUG: DB-INFO (hvilken database er Render egentlig koblet til?)
// -------------------------------------------------------
app.get("/debug/uploads", (req, res) => {
  try {
    const files = fs.readdirSync(uploadDir);
    res.json({ uploadDir, count: files.length, files });
  } catch (e) {
    res.status(500).json({ uploadDir, error: e.message });
  }
});

app.get("/api/debug/db-info", async (req, res) => {
  try {
    const r = await query(
      `
      SELECT
        current_database() AS db,
        current_user AS "user",
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        current_schema() AS schema,
        current_setting('search_path') AS search_path
      `
    );

    // Ikke logg passord, men greit å se host fra DATABASE_URL hvis du vil
    const dbUrl = process.env.DATABASE_URL || "";
    const safeDbUrl = dbUrl ? dbUrl.replace(/:(.*?)@/, ":***@") : null;

    res.json({
      ok: true,
      env: {
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        databaseUrlHostHint: safeDbUrl
      },
      db: r.rows[0]
    });
  } catch (e) {
    console.error("/api/debug/db-info error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/debug/db-tables", async (req, res) => {
  try {
    const r = await query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name
      `
    );
    res.json({ ok: true, tables: r.rows });
  } catch (e) {
    console.error("/api/debug/db-tables error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------------------------------------
//  AUTH
// -------------------------------------------------------

app.post("/api/auth/signup", async (req, res) => {
  const {
    email,
    password,
    fullName,
    birthYear,
    homeCity,
    homeCountry,
    travelStyle,
    budgetPerDay,
    experienceLevel
  } = req.body || {};

  if (!email || !password || !fullName) {
    return res.status(400).json({
      error: "Navn, e-post og passord må fylles ut."
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName  = fullName.trim();

  const birthYearValue =
    birthYear === null || birthYear === "" || birthYear === undefined
      ? null
      : Number(birthYear);

  const budgetPerDayValue =
    budgetPerDay === null || budgetPerDay === "" || budgetPerDay === undefined
      ? null
      : Number(budgetPerDay);

  try {
    // Sjekk om e-posten allerede finnes
    const exists = await query(
      "SELECT id FROM users WHERE email=$1",
      [normalizedEmail]
    );

    if (exists.rowCount > 0) {
      return res
        .status(400)
        .json({ error: "E-posten er allerede i bruk." });
    }

    const hash = await bcrypt.hash(password, 10);

    // Lagre med alle profilfeltene
    const insert = await query(
      `
      INSERT INTO users (
        email,
        password_hash,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      `,
      [
        normalizedEmail,
        hash,
        normalizedName,
        birthYearValue,
        homeCity || null,
        homeCountry || null,
        travelStyle || null,
        budgetPerDayValue,
        experienceLevel || null
      ]
    );

    const user = insert.rows[0];

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d"
    });

    res.json({ token, user });
  } catch (e) {
    console.error("Signup-feil:", e);
    res.status(500).json({ error: "Kunne ikke opprette bruker." });
  }
});

app.get(
  "/api/trips/:id/travel-advice",
  authMiddleware,
  async (req, res) => {
    try {
      const tripId = (req.params.id || "").toString().trim();
      if (!tripId) {
        return res.status(400).json({ error: "Mangler trip-id i URL." });
      }

      // Hent reise (kun kolonner vi er sikre på)
      const tripRes = await query(
        `
        SELECT id, title, description, stops
        FROM trips
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        `,
        [tripId, req.user.id]
      );

      if (!tripRes.rows?.length) {
        return res.status(404).json({ error: "Fant ikke denne reisen." });
      }

      const trip = tripRes.rows[0];

      // Robust stops: kan komme som JSON-string, array, null
      const parseJsonArray = (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      const tripNormalized = {
        ...trip,
        stops: parseJsonArray(trip.stops),
      };

      // Finn land + bygg råd (med trygge fallbacks)
      let country = null;
      try {
        country = await inferCountryForTrip(tripNormalized);
      } catch (err) {
        console.warn("inferCountryForTrip feilet (fortsetter):", err?.message || err);
        country = null;
      }

      // Hvis vi ikke klarer land: gi generelle råd
      let advice = "";
      try {
        advice = await buildTravelAdviceText(country || "generelt");
      } catch (err) {
        console.warn("buildTravelAdviceText feilet (fallback):", err?.message || err);
        advice =
          "Generelle reiseråd: Sjekk pass/visumregler, reiseforsikring, lokale lover og skikker, helse/anbefalte vaksiner, og oppdaterte reiseråd fra UD. Ha digitale og fysiske kopier av viktige dokumenter, og lag en plan for betaling og nødnummer.";
      }

      console.log("DEBUG travel-advice:", {
        tripId,
        country,
        adviceSnippet: (advice || "").slice(0, 120),
      });

      return res.json({
        ok: true,
        tripId,
        country: country || null,
        advice: advice || "",
      });
    } catch (e) {
      console.error("/api/trips/:id/travel-advice-feil:", e);
      return res.status(500).json({
        error: "Kunne ikke hente reiseråd.",
      });
    }
  }
);

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  const normalizedEmail = (email || "").trim().toLowerCase();
  const normalizedPassword = (password || "");

  try {
    const result = await query("SELECT * FROM users WHERE email=$1", [
      normalizedEmail,
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(normalizedPassword, row.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const token = jwt.sign({ userId: row.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: sanitizeUser(row) });
  } catch (e) {
    console.error("Login-feil:", e);
    res.status(500).json({ error: "Kunne ikke logge inn." });
  }
});

// ============ FORGOT PASSWORD ============
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "E-post må fylles inn." });

  const normalizedEmail = String(email).trim().toLowerCase();

  // Alltid samme svar (ikke lekke om e-post finnes)
  const okResponse = {
    ok: true,
    message:
      "Hvis vi finner e-posten i systemet vårt, sender vi instruksjoner for å nullstille passordet."
  };

  try {
    // 1) Env-sjekk – gjør den eksplisitt her så du ser hva som mangler
    const missing = [];
    if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
    if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!process.env.RESEND_FROM) missing.push("RESEND_FROM");
    if (!process.env.FRONTEND_BASE_URL) missing.push("FRONTEND_BASE_URL");
    if (missing.length) {
      console.error("❌ Mangler miljøvariabler:", missing.join(", "));
      return res.status(500).json({ error: `Mangler miljøvariabler: ${missing.join(", ")}` });
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    const RESEND_FROM = process.env.RESEND_FROM;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL;

    const result = await query(
      "SELECT id, email FROM users WHERE email=$1",
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      return res.json(okResponse);
    }

    const userId = result.rows[0].id;

    // 2) Token
    const resetToken = jwt.sign(
      { userId, type: "password_reset" },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3) Reset-lenke til FRONTEND
      const resetUrl = `${FRONTEND_BASE_URL.replace(/\/+$/, "")}/endre-passord-i-grenselos-reise-appen/?token=${encodeURIComponent(resetToken)}`;
      
    // 4) Send e-post via Resend
    const sendRes = await resend.emails.send({
      from: RESEND_FROM,
      to: normalizedEmail,
      subject: "Nullstill passord – Grenseløs Reise",
      html: resetEmailHtml({ resetUrl })
    });

    // 5) Robust logging
    if (sendRes?.error) {
      console.error("❌ Resend send-feil:", {
        to: normalizedEmail,
        error: sendRes.error
      });
      // Returner fortsatt okResponse for å ikke lekke info,
      // men du får feilen i logs
      return res.json(okResponse);
    }

    console.log("✅ Resend forgot-password sendt:", {
      to: normalizedEmail,
      id: sendRes?.data?.id || sendRes?.id,
      from: RESEND_FROM
    });

    return res.json(okResponse);
  } catch (e) {
    console.error("/api/auth/forgot-password-feil:", e);
    // Fortsett å returnere okResponse for sikkerhet (valgfritt),
    // men du kan også returnere 500 hvis du vil.
    return res.json(okResponse);
  }
});


// ============ RESET PASSWORD ============
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "Mangler token eller passord (min 6 tegn)." });
    }

    if (!JWT_SECRET) {
      console.error("❌ JWT_SECRET mangler");
      return res.status(500).json({ error: "Server-konfigurasjon mangler." });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Ugyldig eller utløpt reset-token." });
    }

    if (!decoded?.userId || decoded?.type !== "password_reset") {
      return res.status(401).json({ error: "Ugyldig reset-token." });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);

    const r = await query(
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,email,full_name`,
      [hash, decoded.userId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/auth/reset-password-feil:", e);
    return res.status(500).json({ error: "Kunne ikke resette passord." });
  }
});

app.post("/api/dev/test-email", async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: "Mangler 'to'." });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM;

    const out = await resend.emails.send({
      from,
      to,
      subject: "Test fra Grenseløs Reise",
      html: "<p>Dette er en test. Hvis du ser denne er Resend OK ✅</p>"
    });

    res.json({ ok: true, out });
  } catch (e) {
    console.error("test-email feilet:", e);
    res.status(500).json({ error: e?.message || "test-email feilet" });
  }
});

// -------------------------------------------------------
//  PROFIL
// -------------------------------------------------------

app.get("/api/profile", authMiddleware, async (req, res) => {
  try {
    const id = req.user.id;

    const result = await query(
      `
      SELECT
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      FROM users
      WHERE id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Profil ikke funnet." });
    }

    res.json({ user: result.rows[0] });
  } catch (e) {
    console.error("/api/profile-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente profil." });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Ikke innlogget' });
    }

    // 👇 MÅ matche det du sender fra appen (camelCase)
    const {
      fullName,
      birthYear,
      homeCity,
      homeCountry,
      travelStyle,
      budgetPerDay,
      experienceLevel
    } = req.body || {};

    // Trygge konverteringer
    const birthYearValue =
      birthYear === null || birthYear === '' || birthYear === undefined
        ? null
        : Number(birthYear);

    const budgetPerDayValue =
      budgetPerDay === null ||
      budgetPerDay === '' ||
      budgetPerDay === undefined
        ? null
        : Number(budgetPerDay);

    const { rows } = await query(
      `
      UPDATE users
      SET
        full_name        = COALESCE($1, full_name),
        birth_year       = $2,
        home_city        = $3,
        home_country     = $4,
        travel_style     = $5,
        budget_per_day   = $6,
        experience_level = $7
      WHERE id = $8
      RETURNING
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      `,
      [
        fullName || null,
        birthYearValue,
        homeCity || null,
        homeCountry || null,
        travelStyle || null,
        budgetPerDayValue,
        experienceLevel || null,
        userId
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Fant ikke bruker å oppdatere' });
    }

    console.log('DEBUG /api/profile/update ->', rows[0]);
    res.json({ user: rows[0] });
  } catch (e) {
    console.error('/api/profile/update-feil:', e);
    res.status(500).json({ error: 'Kunne ikke oppdatere profil' });
  }
});

// -------------------------------------------------------
//  ADMIN: BRUKERLISTE
// -------------------------------------------------------

app.get(
  "/api/admin/users",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT
          id,
          email,
          full_name,
          is_admin,
          created_at
        FROM users
        ORDER BY created_at DESC
        `
      );

      res.json({ users: result.rows });
    } catch (e) {
      console.error("/api/admin/users-feil:", e);
      res.status(500).json({ error: "Kunne ikke hente brukere." });
    }
  }
);

// -------------------------------------------------------
//  ADMIN: EPISODER + GALLERI (for virtuell reise)
// -------------------------------------------------------

app.get(
  "/api/admin/grenselos-episodes",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      // 1) Hent ALLE episoder fra Spotify
      const episodes = await fetchGrenselosEpisodes();
      if (!Array.isArray(episodes)) {
        throw new Error("fetchGrenselosEpisodes() ga ikke en liste.");
      }

      const episodeIds = episodes.map((ep) => ep.id);

      // 2) Hent eksisterende trips knyttet til disse episodene
      let tripsByEpisodeId = {};
        if (episodeIds.length > 0) {
          const tripsRes = await query(
            `
              SELECT id, source_episode_id, gallery, packing_list, hotels, created_at
              FROM trips
              WHERE source_type = 'grenselos_episode'
                AND source_episode_id = ANY($1)
              ORDER BY source_episode_id ASC, created_at DESC
            `,
            [episodeIds]
          );

          // Bruk NYESTE system-trip per episode som "canonical"
          tripsByEpisodeId = tripsRes.rows.reduce((acc, row) => {
            if (!acc[row.source_episode_id]) {
              acc[row.source_episode_id] = row;
            }
            return acc;
          }, {});
        }
        
      // 3) Kombiner Spotify-episoder + eksisterende trips
      const data = episodes.map((ep) => {
        const trip = tripsByEpisodeId[ep.id] || null;

        // Parse galleri
        let gallery = [];
        if (trip?.gallery) {
          try {
            gallery =
              typeof trip.gallery === "string"
                ? JSON.parse(trip.gallery)
                : trip.gallery;
          } catch (err) {
            console.warn(
              "Kunne ikke parse galleri for trip",
              trip.id,
              err.message
            );
            gallery = [];
          }
        }

        return {
          episode_id: ep.id,
          name: ep.name,
          description: ep.description,
          release_date: ep.release_date,
          image: ep.image,
          external_url: ep.external_url,
          trip_id: trip ? trip.id : null,
          gallery
        };
      });

      res.json({ episodes: data });
    } catch (e) {
      console.error("/api/admin/grenselos-episodes-feil:", e);
      res.status(500).json({ error: "Kunne ikke hente episoder/galleri." });
    }
  }
);

app.get(
  "/api/debug/grenselos-count",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const episodes = await fetchGrenselosEpisodes();

      const total = Array.isArray(episodes) ? episodes.length : 0;
      const first = episodes[0] || null;
      const last = episodes[episodes.length - 1] || null;

      console.log(
        `[debug/grenselos-count] Fant ${total} episoder fra Spotify`
      );

      res.json({
        ok: true,
        totalEpisodes: total,
        firstEpisode: first
          ? { id: first.id, name: first.name, release_date: first.release_date }
          : null,
        lastEpisode: last
          ? { id: last.id, name: last.name, release_date: last.release_date }
          : null
      });
    } catch (e) {
      console.error("/api/debug/grenselos-count-feil:", e);
      res
        .status(500)
        .json({ error: "Kunne ikke hente antall Grenseløs-episoder." });
    }
  }
);

// -------------------------------------------------------
//  DEBUG: INSPEKTÉR ÉN TRIP + EV. SYSTEM-TRIP
// -------------------------------------------------------

app.get(
  "/api/debug/trip/:id",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const tripId = req.params.id;

      // Hjelper for å parse felt som kan være JSON-string/array/null
      const parseJsonArray = (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      // 1) Hent selve trip-en (den du ser i appen under "Lagrede reiser")
      const tripRes = await query(
        `
        SELECT *
        FROM trips
        WHERE id = $1
        `,
        [tripId]
      );

      if (tripRes.rowCount === 0) {
        return res.status(404).json({ error: "Fant ikke trip med denne ID-en." });
      }

      const tripRow = tripRes.rows[0];

      const parsedTrip = {
        ...tripRow,
        stops:        parseJsonArray(tripRow.stops),
        packing_list: parseJsonArray(tripRow.packing_list),
        gallery:      parseJsonArray(tripRow.gallery),
        hotels:       parseJsonArray(tripRow.hotels)
      };

      // 2) Hvis den er knyttet til en Grenseløs-episode:
      //    hent "canonical" system-trip for samme episode
      let systemTripRaw = null;
      let systemTripParsed = null;

      if (tripRow.source_episode_id) {
        const sysRes = await query(
          `
          SELECT *
          FROM trips
          WHERE source_type = 'grenselos_episode'
            AND source_episode_id = $1
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [tripRow.source_episode_id]
        );

        if (sysRes.rowCount > 0) {
          systemTripRaw = sysRes.rows[0];
          systemTripParsed = {
            ...systemTripRaw,
            stops:        parseJsonArray(systemTripRaw.stops),
            packing_list: parseJsonArray(systemTripRaw.packing_list),
            gallery:      parseJsonArray(systemTripRaw.gallery),
            hotels:       parseJsonArray(systemTripRaw.hotels)
          };
        }
      }

      // 3) Returnér alt samlet, så du kan se forskjellen tydelig
      res.json({
        ok: true,
        tripId,
        userTrip: {
          raw: tripRow,
          parsed: parsedTrip
        },
        systemTrip: systemTripRaw
          ? {
              raw: systemTripRaw,
              parsed: systemTripParsed
            }
          : null
      });
    } catch (e) {
      console.error("/api/debug/trip/:id-feil:", e);
      res.status(500).json({ error: "Kunne ikke inspisere trip." });
    }
  }
);

app.post(
  "/api/admin/grenselos-episodes/:episodeId/gallery",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { gallery } = req.body || {};

      if (!Array.isArray(gallery)) {
        return res.status(400).json({
          error:
            "Galleri må være en liste (array) med objekter: [{ url, title, caption }]"
        });
      }

      // 1) Finn episoden fra Spotify (så vi har navn / beskrivelse mm.)
      const episodes = await fetchGrenselosEpisodes();
      const episode = episodes.find((e) => e.id === episodeId);

      if (!episode) {
        return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
      }

      // 2) Sørg for at det finnes en trip for denne episoden
      const tripId = await ensureTripForEpisode(episode, req.user.id);

      // 3) Oppdater galleri på denne trip'en
      const update = await query(
        `
        UPDATE trips
        SET gallery = $1
        WHERE id = $2
        RETURNING *
        `,
        [JSON.stringify(gallery), tripId]
      );

      const row = update.rows[0];

      res.json({
        trip: {
          ...row,
          gallery: gallery
        }
      });
    } catch (e) {
      console.error(
        "/api/admin/grenselos-episodes/:episodeId/gallery-feil:",
        e
      );
      res.status(500).json({ error: "Kunne ikke lagre galleri for episoden." });
    }
  }
);

app.post(
  "/api/admin/grenselos-episodes/:episodeId/gallery-upload",
  authMiddleware,
  adminOnlyMiddleware,
  upload.array("images", 10),
  async (req, res) => {
    try {
      const { episodeId } = req.params;
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({ error: "Ingen bildefiler ble lastet opp." });
      }

      // 1) Finn episoden fra Spotify
      const episodes = await fetchGrenselosEpisodes();
      const episode = episodes.find((e) => e.id === episodeId);

      if (!episode) {
        return res.status(404).json({ error: "Episode ikke funnet på Spotify." });
      }

      // 2) Sørg for at det finnes en trip for denne episoden
      const tripId = await ensureTripForEpisode(episode, req.user.id);

      // 3) Hent eksisterende galleri (om det finnes)
      const tripRes = await query(
        `SELECT gallery FROM trips WHERE id = $1`,
        [tripId]
      );

      let existingGallery = [];
      if (tripRes.rowCount > 0 && tripRes.rows[0].gallery) {
        try {
          existingGallery =
            typeof tripRes.rows[0].gallery === "string"
              ? JSON.parse(tripRes.rows[0].gallery)
              : tripRes.rows[0].gallery;
        } catch (err) {
          console.warn("Kunne ikke parse eksisterende galleri:", err.message);
        }
      }

      // 4) Lag nye galleri-elementer basert på opplastede filer
      const newItems = files.map((file) => ({
        url: `/uploads/${file.filename}`, // lokal URL fra backend
        title: null,
        caption: null
      }));

      const gallery = [...existingGallery, ...newItems];

      // 5) Lagre i databasen
      const update = await query(
        `
        UPDATE trips
        SET gallery = $1
        WHERE id = $2
        RETURNING id, gallery
        `,
        [JSON.stringify(gallery), tripId]
      );

      // 6) Sørg for at vi alltid returnerer den lagrede strukturen
      let savedGallery = gallery;
      if (update.rowCount > 0 && update.rows[0].gallery) {
        try {
          savedGallery =
            typeof update.rows[0].gallery === "string"
              ? JSON.parse(update.rows[0].gallery)
              : update.rows[0].gallery;
        } catch (err) {
          console.warn("Kunne ikke parse lagret galleri:", err.message);
        }
      }

      console.log(
        "✅ gallery-upload lagret",
        { tripId, count: savedGallery.length }
      );

      res.json({
        ok: true,
        tripId,
        gallery: savedGallery
      });
    } catch (e) {
      console.error(
        "/api/admin/grenselos-episodes/:episodeId/gallery-upload-feil:",
        e
      );
      res.status(500).json({
        error: "Kunne ikke lagre bilder for episoden."
      });
    }
  }
);

// -------------------------------------------------------
//  ADMIN: TOGGLE ADMIN-RETTIGHETER
// -------------------------------------------------------

app.post(
  "/api/admin/users/:id/toggle-admin",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const targetId = req.params.id;

      // (Valgfritt) Hindre at du fjerner admin fra deg selv:
      // if (targetId === req.user.id) {
      //   return res.status(400).json({ error: "Du kan ikke endre egne admin-rettigheter her." });
      // }

      const result = await query(
        `
        UPDATE users
        SET is_admin = NOT is_admin
        WHERE id = $1
        RETURNING id,email,full_name,is_admin,created_at
        `,
        [targetId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Bruker ikke funnet." });
      }

      res.json({ user: result.rows[0] });
    } catch (e) {
      console.error("/api/admin/users/:id/toggle-admin-feil:", e);
      res.status(500).json({ error: "Kunne ikke oppdatere admin-rettigheter." });
    }
  }
);

// -------------------------------------------------------
//  ADMIN: SLETT BRUKER
// -------------------------------------------------------

app.post(
  "/api/admin/users/:id/delete",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const targetId = req.params.id;

      // Valgfritt: ikke la admin slette seg selv
      if (targetId === req.user.id) {
        return res
          .status(400)
          .json({ error: "Du kan ikke slette deg selv via admin-panelet." });
      }

      const result = await query(
        `DELETE FROM users WHERE id=$1 RETURNING id,email`,
        [targetId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Bruker ikke funnet." });
      }

      res.json({
        success: true,
        deletedId: result.rows[0].id,
        email: result.rows[0].email
      });
    } catch (e) {
      console.error("/api/admin/users/:id/delete-feil:", e);
      res.status(500).json({ error: "Kunne ikke slette bruker." });
    }
  }
);

// -------------------------------------------------------
//  KI-GENERERT REISE
// -------------------------------------------------------

app.post("/api/ai/generate-trip", authMiddleware, async (req, res) => {
  try {
    const { sourceUrl, userDescription, useProfile } = req.body || {};

    // --- 1) Hent evt. brukerprofil til prompten ---
    let profile = null;
    if (useProfile && req.user && req.user.id) {
      try {
        const result = await query(
          `
          SELECT
            email,
            full_name,
            birth_year,
            home_city,
            home_country,
            travel_style,
            budget_per_day,
            experience_level
          FROM users
          WHERE id = $1
          `,
          [req.user.id]
        );
        profile = result.rows[0] || null;
      } catch (e) {
        console.warn("Klarte ikke å hente profil til KI-prompt:", e.message);
      }
    }

    // --- 2) Systemprompt: med STRENG pakkeliste-regel (4 kategorier) ---
    const systemPrompt = `
Du er en erfaren reiseplanlegger som lager konkrete reiseforslag.

Du MÅ ALLTID svare med gyldig JSON, uten forklarende tekst rundt.

Output-format (mal):

{
  "title": "Kort og konkret tittel på reisen",
  "description": "Kort intro til reisen (2–5 setninger).",
  "stops": [
    {
      "day": 1,
      "name": "Stedsnavn",
      "description": "Hva gjør man denne dagen, konkrete forslag.",
      "lat": 40.8518,
      "lng": 14.2681
    }
  ],
  "packing_list": [
    {
      "category": "Klær",
      "items": [
        "Vind- og regnjakke",
        "Gode joggesko",
        "2–3 t-skjorter",
        "Behagelig bukse/shorts"
      ]
    },
    {
      "category": "Toalettsaker",
      "items": [
        "Tannbørste og tannkrem",
        "Deodorant",
        "Solkrem",
        "Eventuelle faste medisiner"
      ]
    },
    {
      "category": "Elektronikk",
      "items": [
        "Mobil og lader",
        "Powerbank",
        "Adapter om nødvendig",
        "Hodetelefoner"
      ]
    },
    {
      "category": "Annet",
      "items": [
        "Pass/ID-kort",
        "Reiseforsikringsbevis",
        "Solbriller",
        "Liten dagstursekk"
      ]
    }
  ],
  "hotels": [
    {
      "name": "Eksempel Hotel",
      "location": "By / område",
      "description": "Kort hvorfor dette passer til turen.",
      "price_per_night": 1200,
      "url": "https://…"
    }
  ]
}

VIKTIG OM PACKING_LIST:
- "packing_list" SKAL ALLTID være en liste (array) med NØYAKTIG 4 elementer.
- De 4 elementene SKAL ha "category" lik:
    1) "Klær"
    2) "Toalettsaker"
    3) "Elektronikk"
    4) "Annet"
- Rekkefølgen på kategoriene kan være denne, men kategorinavnene MÅ være akkurat disse.
- Hver kategori SKAL ha en "items"-liste med 3–10 KONKRETE ting (strenger).
- Ikke skriv generelle ting som "annet", "diverse", "osv." som item. Hver item skal være en konkret gjenstand.

VIKTIG OM STOPS:
- "stops" SKAL være en liste (array).
- Bruk helst 3–10 stopp.
- Hvert stopp SKAL ha "name" og "description".
- "day" skal være et positivt heltall som angir rekkefølgen (1, 2, 3 ...).
- Hvis du ikke vet koordinater, sett "lat" og "lng" til null.

VIKTIG OM HOTELS:
- "hotels" SKAL være en liste (array) med 2–6 forslag totalt.
- Hvert hotell SKAL ha "name".
- "price_per_night" skal være et tall (omtrentlig pris per natt) i NOK hvis det er naturlig.
- Hvis du er usikker på pris, kan "price_per_night" være null.

Returner strukturert JSON med “title”, “description”, “stops”, “packing_list”, “hotels” og “experiences”.
“experiences” er en array av opplevelser som ofte krever billett/booking, med feltene: title, location, description, og helst booking_url.
`.trim();

    // --- 3) Bygg userPrompt ---
    let userPrompt = "";

    if (sourceUrl) {
      userPrompt += `Kilde (lenke, artikkel, episode e.l.):\n${sourceUrl}\n\n`;
    }

    if (userDescription) {
      userPrompt += `Brukerens beskrivelse/ønsker:\n${userDescription}\n\n`;
    }

    if (profile) {
      userPrompt += `Brukerprofil (kan brukes til å tilpasse reisen):\n`;
      userPrompt += JSON.stringify(profile, null, 2);
      userPrompt += `\n\n`;
    }

    if (!userPrompt.trim()) {
      userPrompt =
        "Lag et konkret reiseforslag (5–7 dager) et sted i Europa, med stopp, pakkeliste i 4 kategorier (Klær, Toalettsaker, Elektronikk, Annet) og 2–6 hotellforslag.";
    }

    // --- 4) Kall OpenAI ---
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "";

    // --- 5) Forsøk å parse JSON med extractJson ---
    const parsed = extractJson(aiText);

    let trip;

    if (parsed && typeof parsed === "object") {
      // Normaliser – nå med stops + packing_list + hotels
      trip = normalizeTripStructure(parsed);
    } else {
      // Fallback: vi fikk ikke ren JSON, men vi vil fortsatt returnere noe
      trip = {
        title: "Reiseforslag fra KI (tekst)",
        description: aiText || null,
        stops: [],
        packing_list: [],
        hotels: []
      };
    }

    // --- 6) Returner strukturert trip + rå KI-tekst ---
    res.json({
      ok: true,
      trip,
      raw: aiText
    });
  } catch (e) {
    console.error("/api/ai/generate-trip-feil:", e);
    res
      .status(500)
      .json({ error: "Kunne ikke generere reiseforslag." });
  }
});

// Helper for å normalisere pakkeliste-struktur
function normalizePackingForClient(rawPacking) {
  if (!rawPacking) return [];

  // Hvis JSON-string → parse
  if (typeof rawPacking === "string") {
    try {
      return normalizePackingForClient(JSON.parse(rawPacking));
    } catch {
      return [];
    }
  }

  // Hvis objekt: { "Klær": ["T-skjorte", ...] }
  if (!Array.isArray(rawPacking) && typeof rawPacking === "object") {
    const groups = [];
    for (const [key, value] of Object.entries(rawPacking)) {
      const category = key?.trim() || "Annet";

      let items = value;
      if (typeof items === "string") {
        items = items.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      }
      if (!Array.isArray(items)) items = [];

      items = items.map((x) => x.trim()).filter(Boolean);

      if (items.length) {
        groups.push({ category, items });
      }
    }
    return groups;
  }

  // Hvis array
  if (Array.isArray(rawPacking)) {
    // Streng-liste → én gruppe
    if (rawPacking.length && typeof rawPacking[0] === "string") {
      const items = rawPacking
        .map((x) => x.trim())
        .filter(Boolean);
      return items.length ? [{ category: "Annet", items }] : [];
    }

    // Gruppe-liste
    return rawPacking
      .map((group) => {
        if (typeof group === "string") {
          return { category: "Annet", items: [group.trim()] };
        }
        if (!group || typeof group !== "object") {
          return { category: "Annet", items: [] };
        }

        const category = group.category?.trim() || "Annet";

        let items = group.items;
        if (typeof items === "string") {
          items = items.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
        }
        if (!Array.isArray(items)) items = [];

        items = items.map((x) => x.trim()).filter(Boolean);

        return { category, items };
      })
      .filter((g) => g.items.length > 0);
  }

  return [];
}

// GET: én reise (med canonical override for episode-turer + entitlements + destination_text)
app.get("/api/trips/:id", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    const tripRes = await query(
      `
      SELECT
        id,
        user_id,
        title,
        description,
        stops,
        gallery,
        hotels,
        packing_list,
        experiences,
        source_type,
        source_episode_id,
        episode_url,
        created_at,
        updated_at
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    // --- helpers ---
    const toArray = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try {
          const x = JSON.parse(v);
          return Array.isArray(x) ? x : [];
        } catch {
          return [];
        }
      }
      // jsonb kommer ofte som object/array allerede, men håndter object -> []
      return Array.isArray(v) ? v : [];
    };

    const toJson = (v, fallback) => {
      if (v === null || v === undefined) return fallback;
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return fallback;
        }
      }
      return v;
    };

    const pickDestinationTextFromStops = (stops) => {
      try {
        const s = Array.isArray(stops) ? stops : [];
        const s1 = s[0];
        if (!s1 || typeof s1 !== "object") return null;

        const name =
          s1.name ||
          s1.title ||
          s1.place ||
          s1.city ||
          s1.location ||
          s1.destination ||
          null;

        const country = s1.country || s1.countryName || null;

        const parts = [name, country].filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
        return parts.length ? parts.join(", ") : null;
      } catch {
        return null;
      }
    };

    // --- parse base ---
    let stops = toArray(row.stops);
    let gallery = toArray(row.gallery);
    let hotels = toArray(row.hotels);
    let experiences = toArray(row.experiences);
    let packing = toJson(row.packing_list, []);

    // --- canonical override for episode-trip ---
    // Hvis dette er en tur som peker på en episode, bruk siste "grenselos_episode" som canonical kilde
    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT
          gallery,
          hotels,
          packing_list,
          experiences,
          stops,
          created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );

      const c = canonRes.rows?.[0] || null;
      if (c) {
        // stops: behold gjerne brukerens stops om du vil; men for “episode-trip” er canonical ofte riktig
        // Her velger jeg canonical hvis den finnes, ellers fallback til original.
        const canonStops = toArray(c.stops);
        if (canonStops.length) stops = canonStops;

        gallery = toArray(c.gallery);
        hotels = toArray(c.hotels);
        experiences = toArray(c.experiences);
        packing = toJson(c.packing_list, []);
      }
    }

    // --- normalize items (best effort) ---
    const hotelsFull = (hotels || [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({ ...h, url: makeHotelUrl(h) }));

    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

    const packingFull = normalizePackingForClient(packing);

    // --- teasers ---
    const hotelsPreview = hotelsFull.slice(0, 3).map((h) => ({
      name: h?.name || h?.title || "Hotell",
      location: h?.location || h?.city || h?.area || null,
    }));

    const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
      name: x?.name || x?.title || "Opplevelse",
      location: x?.location || x?.city || x?.area || null,
      description: x?.description || null,
    }));

    const packingPreview = Array.isArray(packingFull) ? packingFull.slice(0, 6) : [];

    const locked = {
      hotels: !isPro,
      experiences: !isPro,
      packing_list: !isPro,
    };

    const destination_text = pickDestinationTextFromStops(stops);

    return res.json({
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      description: row.description,
      source_type: row.source_type,
      source_episode_id: row.source_episode_id,
      episode_url: row.episode_url,
      created_at: row.created_at,
      updated_at: row.updated_at,

      // Parsed/normalized:
      stops,
      destination_text,
      gallery,

      // Gated payload:
      hotels: isPro ? hotelsFull : hotelsPreview,
      experiences: isPro ? experiencesFull : experiencesPreview,
      packing_list: isPro ? packingFull : packingPreview,

      entitlements: { isPro, locked },
      counts: {
        hotels: hotelsFull.length,
        experiences: experiencesFull.length,
        packing_list: Array.isArray(packingFull) ? packingFull.length : 0,
        stops: Array.isArray(stops) ? stops.length : 0,
        gallery: Array.isArray(gallery) ? gallery.length : 0,
      },
    });
  } catch (err) {
    console.error("/api/trips/:id GET-feil:", err);
    return res.status(500).json({ error: "Kunne ikke hente reisen." });
  }
});



// ----------------------------------------------------------------------
// 📌 API: Hent alle brukerens reiser
//  - Canonical galleri/hoteller/pakkeliste/opplevelser for episode-reiser
//  - Generisk galleri for "fra scratch"-reiser
//  - Klikkbare hoteller og opplevelser (url)
//  - 🔒 Paywall: låser hoteller/pakkeliste/opplevelser for ikke-premium (ikke antall turer)
// ----------------------------------------------------------------------
app.get("/api/trips", authMiddleware, async (req, res) => {
  try {
    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    // 1) Hent brukerens reiser (ikke system-trips)
    const baseRes = await query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
        AND (
          source_type IS NULL
          OR source_type = 'template'
          OR source_type = 'user_episode_trip'
        )
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const rows = baseRes.rows || [];

    // 2) Finn episode-IDs som brukerturene peker på
    const episodeIds = [
      ...new Set(
        rows
          .map((r) => r.source_episode_id)
          .filter((id) => typeof id === "string" && id.trim() !== "")
      )
    ];

    // 3) Hent canonical data fra SYSTEM-trips for relevante episoder (nyeste per episode)
    let canonicalByEpisodeId = {};
    if (episodeIds.length > 0) {
      const canonRes = await query(
        `
        SELECT
          source_episode_id,
          gallery,
          hotels,
          packing_list,
          experiences,
          created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = ANY($1)
        ORDER BY source_episode_id ASC, created_at DESC
        `,
        [episodeIds]
      );

      canonicalByEpisodeId = canonRes.rows.reduce((acc, row) => {
        const epId = row.source_episode_id;
        if (!epId) return acc;

        if (!acc[epId]) {
          acc[epId] = {
            gallery: parseJsonArray(row.gallery),
            hotels: parseJsonArray(row.hotels),
            packing_list: row.packing_list,
            experiences: parseJsonArray(row.experiences)
          };
        }
        return acc;
      }, {});
    }

    // 4) Normaliser + gate payload
    const trips = rows.map((row) => {
      const stops = parseJsonArray(row.stops);

      let gallery = parseJsonArray(row.gallery);
      let hotels = parseJsonArray(row.hotels);
      let packing = row.packing_list;
      let experiences = parseJsonArray(row.experiences);

      const episodeId = row.source_episode_id;

      if (episodeId && canonicalByEpisodeId[episodeId]) {
        const canon = canonicalByEpisodeId[episodeId];
        gallery = parseJsonArray(canon.gallery);
        hotels = parseJsonArray(canon.hotels);
        packing = canon.packing_list;
        experiences = parseJsonArray(canon.experiences);
      } else {
        if (!Array.isArray(gallery) || gallery.length === 0) {
          // behold din eksisterende:
          gallery = getGenericVirtualTripGallery(3);
        }
      }

      // Full normalisering (kun brukt når pro, ellers teaser)
      const hotelsFull = (hotels || [])
        .filter((h) => h && typeof h === "object")
        .map((h) => ({ ...h, url: makeHotelUrl(h) }));

      const experiencesFull = (experiences || [])
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

      const packingFull = normalizePackingForClient(packing);

      // Teasers (gratis)
      const hotelsPreview = hotelsFull.slice(0, 3).map((h) => ({
        name: h?.name || h?.title || "Hotell",
        location: h?.location || h?.city || h?.area || null
      }));

      const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
        name: x?.name || x?.title || "Opplevelse",
        location: x?.location || x?.city || x?.area || null
      }));

      const packingPreview = Array.isArray(packingFull) ? packingFull.slice(0, 6) : [];

      const locked = {
        hotels: !isPro,
        experiences: !isPro,
        packing_list: !isPro
      };

      return {
        ...row,
        stops,
        gallery,

        // 👇 Her er selve “mur”-effekten:
        hotels: isPro ? hotelsFull : hotelsPreview,
        experiences: isPro ? experiencesFull : experiencesPreview,
        packing_list: isPro ? packingFull : packingPreview,

        entitlements: { isPro, locked },

        // praktisk for UI (kan vise “Se alle (12)” selv om preview):
        counts: {
          hotels: hotelsFull.length,
          experiences: experiencesFull.length,
          packing_list: Array.isArray(packingFull) ? packingFull.length : 0
        }
      };
    });

    return res.json({ trips });
  } catch (err) {
    console.error("/api/trips GET-feil:", err);
    return res.status(500).json({ error: "Kunne ikke hente reiser." });
  }
});

// -------------------------------------------------------
//  KI-basert galleri for "fra scratch"-reiser
//  Forsøker å hente 5–8 bilder som matcher destinasjon/stemning
// -------------------------------------------------------

async function unsplashSearchOne(queryText, { orientation = "landscape" } = {}) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error("Mangler UNSPLASH_ACCESS_KEY");

  const q = String(queryText || "").trim();
  if (!q) return null;

  const url =
    "https://api.unsplash.com/search/photos?" +
    new URLSearchParams({
      query: q,
      per_page: "1",
      orientation
    }).toString();

  const r = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}` }
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.warn("Unsplash search feilet:", r.status, txt.slice(0, 200));
    return null;
  }

  const data = await r.json();
  const photo = data?.results?.[0];
  if (!photo?.urls?.raw) return null;

  // Stabil bilde-URL (raw + params)
  const imageUrl =
    photo.urls.raw +
    (photo.urls.raw.includes("?") ? "&" : "?") +
    "auto=format&fit=crop&w=1600&q=80";

  return {
    url: imageUrl,
    source: "unsplash",
    unsplash: {
      id: photo.id,
      photographer: photo.user?.name || null,
      photographerUrl: photo.user?.links?.html || null,
      photoUrl: photo.links?.html || null
    }
  };
}

function buildStopContext(stopsRaw) {
  let stops = stopsRaw;

  if (typeof stops === "string") {
    try { stops = JSON.parse(stops); } catch { stops = []; }
  }

  if (!Array.isArray(stops)) stops = [];

  return stops
    .map((s) => {
      const name = s?.name ? String(s.name).trim() : "";
      const desc = s?.description ? String(s.description).trim() : "";
      return { name, desc };
    })
    .filter((x) => x.name);
}

async function generateGalleryForTrip(title, description, stopsRaw) {
  try {
    const stops = buildStopContext(stopsRaw);

    // 1) KI lager "query" per bilde, ikke URL
    const systemPrompt = `
Du lager søkestrenger (queries) for å finne gode reisebilder.
Du MÅ svare med REN JSON.

Format:
{
  "gallery": [
    {
      "query": "sted + land/region + motiv (f.eks. beach/old town/mountain)",
      "title": "Kort tittel",
      "caption": "Kort bildetekst",
      "stopIndex": 0
    }
  ]
}

KRAV:
- 1 element per stopp (stopIndex refererer til rekkefølgen i stopp-lista).
- query må være konkret og inneholde sted + land/region + motiv.
- Maks 8 elementer.
- Ingen URLer, kun query.
`.trim();

    const context = `
Tittel: ${title || ""}
Beskrivelse: ${description || ""}

Stopp:
${stops.map((s, i) => `#${i} ${s.name}\n${s.desc || ""}`).join("\n\n")}
`.trim();

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: context }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("❌ JSON parse-feil i generateGalleryForTrip:", e, content);
      return getGenericVirtualTripGallery(3);
    }

    const raw = Array.isArray(parsed.gallery) ? parsed.gallery : [];
    const wanted = raw
      .map((x) => {
        const query = typeof x?.query === "string" ? x.query.trim() : "";
        const stopIndex = Number.isInteger(x?.stopIndex) ? x.stopIndex : null;
        if (!query || stopIndex === null) return null;

        return {
          query,
          title: (typeof x?.title === "string" && x.title.trim()) || null,
          caption: (typeof x?.caption === "string" && x.caption.trim()) || null,
          stopIndex
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    if (!wanted.length) return getGenericVirtualTripGallery(3);

    // 2) Backend henter ekte bilder fra Unsplash (1 per query)
    const out = [];
    for (const item of wanted) {
      const stop = stops[item.stopIndex];
      const fallbackQuery = stop?.name
        ? `${stop.name} ${title || ""} travel photo`
        : `${title || "travel"} travel photo`;

      const q = item.query || fallbackQuery;

      const hit = await unsplashSearchOne(q);
      if (!hit) continue;

      out.push({
        url: hit.url,
        title: item.title || stop?.name || title || "Reisebilde",
        caption: item.caption || stop?.desc || null,

        // valgfritt metadata
        source: hit.source,
        attribution: hit.unsplash
          ? {
              provider: "Unsplash",
              photographer: hit.unsplash.photographer,
              photographerUrl: hit.unsplash.photographerUrl,
              photoUrl: hit.unsplash.photoUrl
            }
          : null,

        stopIndex: item.stopIndex
      });
    }

    // Hvis Unsplash ikke ga noe (key mangler eller tomt)
    if (!out.length) return getGenericVirtualTripGallery(3);

    return out;
  } catch (e) {
    console.error("❌ generateGalleryForTrip-feil:", e);
    return getGenericVirtualTripGallery(3);
  }
}

// -------------------------------------------------------
//  GENERISKE BILDER FOR VIRTUELL REISE (IKKE-EPISODE-TRIPS)
// -------------------------------------------------------

// En liten liste med generiske reisebilder (fri bruk via picsum.photos)
// Disse ligger EKSTERN på nett og trenger ikke å lastes opp i backend.
const GENERIC_VIRTUAL_TRIP_IMAGES = [
  {
    url: "https://picsum.photos/seed/grenselos1/1200/800",
    title: "Utsikt over fjell og dal",
    caption: "Illustrasjonsfoto – generisk reisebilde."
  },
  {
    url: "https://picsum.photos/seed/grenselos2/1200/800",
    title: "Kystlinje og hav",
    caption: "Illustrasjonsfoto – inspirasjon til kystreiser."
  },
  {
    url: "https://picsum.photos/seed/grenselos3/1200/800",
    title: "Bygate på kveldstid",
    caption: "Illustrasjonsfoto – storbyfølelse."
  },
  {
    url: "https://picsum.photos/seed/grenselos4/1200/800",
    title: "Små vei og åpent landskap",
    caption: "Illustrasjonsfoto – roadtrip-stemning."
  }
];

// -------------------------------------------------------
//  GENERISK FALLBACK-GALLERI (TRYGG BACKUP)
// -------------------------------------------------------
function getGenericVirtualTripGallery(count = 3) {
  if (
    !Array.isArray(GENERIC_VIRTUAL_TRIP_IMAGES) ||
    GENERIC_VIRTUAL_TRIP_IMAGES.length === 0
  ) {
    return [];
  }

  // Shuffle uten å mutere originalen
  const shuffled = [...GENERIC_VIRTUAL_TRIP_IMAGES].sort(
    () => Math.random() - 0.5
  );

  return shuffled
    .slice(0, Math.min(count, GENERIC_VIRTUAL_TRIP_IMAGES.length))
    .map((item, idx) => ({
      url: item.url,
      title: item.title || "Reisebilde",
      caption: item.caption || "Illustrasjonsfoto",
      source: "fallback",        // 👈 viktig
      stopIndex: idx,             // 👈 stabil rekkefølge
      attribution: null
    }));
}

// Hent gode søkeord fra stopp + tittel/beskrivelse
function buildLocationQueriesFromStops(stops, tripTitle = "", tripDescription = "") {
  const queries = [];
  const seen = new Set();

  const pushUnique = (q) => {
    if (!q) return;
    const trimmed = q.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };

  const arrStops = Array.isArray(stops) ? stops : [];

  // 1) Navn / city / country fra stopp
  for (const s of arrStops) {
    const name = s?.name;
    const city = s?.city;
    const country = s?.country;

    if (city && country) {
      pushUnique(`${city}, ${country}`);
      pushUnique(`${city} ${country} travel`);
    } else if (city) {
      pushUnique(`${city} travel`);
    } else if (name) {
      const first = String(name).split(",")[0];
      if (first.length > 2) {
        pushUnique(first);
        pushUnique(`${first} travel`);
      }
    }

    if (queries.length >= 4) break;
  }

  // 2) Fyll på fra tittel/beskrivelse hvis få queries
  if (queries.length < 3) {
    const base = `${tripTitle} ${tripDescription}`.trim();
    if (base) {
      const words = base
        .split(/[\s,–\-:]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 3);
      for (const w of words) {
        pushUnique(w);
        if (queries.length >= 6) break;
      }
    }
  }

  // 3) Utvid med travel/landscape-varianter
  const expanded = [];
  const seen2 = new Set();
  for (const q of queries) {
    const variants = [q, `${q} travel`, `${q} landscape`];
    for (const v of variants) {
      const key = v.toLowerCase();
      if (seen2.has(key)) continue;
      seen2.add(key);
      expanded.push(v);
    }
  }

  return expanded.slice(0, 6);
}

function sanitizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;

  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const lower = withProto.toLowerCase();

  if (
    lower.includes("example.com") ||
    lower.includes("example.org") ||
    lower.includes("example.net")
  ) return null;

  // Enkel URL-validering
  try {
    new URL(withProto);
    return withProto;
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  console.log("➡️", req.method, req.originalUrl);
  next();
});

app.post("/api/trips", authMiddleware, async (req, res) => {
  try {
    let {
      title,
      description,
      stops,
      packing_list,
      hotels,
      gallery,
      source_type,
      source_episode_id,
      episode_url,
      experiences
    } = req.body ?? {};

    // ---------------- Helpers ----------------
    const parseArrayField = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    const toNum = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim()) {
        const n = Number(v.replace(",", "."));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const normalizeStops = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      return a
        .filter((s) => s && typeof s === "object")
        .map((s, idx) => {
          const dayRaw = s.day ?? s.order ?? null;
          const day =
            typeof dayRaw === "number"
              ? dayRaw
              : toNum(dayRaw) ?? (idx + 1);

          return {
            ...s,
            day,
            name: (s.name || s.title || `Stopp ${idx + 1}`).toString().trim(),
            description: (s.description || "").toString().trim(),
            location: (s.location || s.address || s.subtitle || null)?.toString?.().trim?.() ?? s.location ?? null,
            lat: toNum(s.lat ?? s.latitude),
            lng: toNum(s.lng ?? s.longitude)
          };
        })
        .filter((s) => s.name);
    };

    const stopHasCoords = (s) =>
      s &&
      typeof s === "object" &&
      typeof s.lat === "number" &&
      Number.isFinite(s.lat) &&
      typeof s.lng === "number" &&
      Number.isFinite(s.lng);

    // ---------------- Normalisering ----------------
    const rawStops = parseArrayField(stops);
    let finalStops = normalizeStops(rawStops);

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Mangler title i request body." });
    }
    title = String(title).trim();

    // Stops kan komme tomt fra preview – men for vanlige reiser krever vi stops
    // (for episode-reiser kan vi hente stops fra system-trip under)
    let finalPacking = parseArrayField(packing_list);
    let finalHotels = parseArrayField(hotels);
    let finalGallery = parseArrayField(gallery);
    let finalExperiences = parseArrayField(experiences);

    
    // ---------------- Episode-baserte reiser ----------------
    let sourceType = null;

    if (source_episode_id) {
      sourceType = "user_episode_trip";

      const sysRes = await query(
        `
          SELECT stops, packing_list, hotels, gallery, experiences
          FROM trips
          WHERE source_type = 'grenselos_episode'
            AND source_episode_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [source_episode_id]
      );

      if (sysRes.rowCount > 0) {
        const sys = sysRes.rows[0];

        const sysStops = normalizeStops(parseArrayField(sys.stops));
        const clientHasAnyCoords = finalStops.some(stopHasCoords);

        // ✅ Viktig: hvis klienten ikke har coords (eller stops er tomme) → bruk system-stops
        if (finalStops.length === 0 || !clientHasAnyCoords) {
          if (sysStops.length > 0) finalStops = sysStops;
        }

        // Packing/hotels fallback fra system hvis klienten ikke sendte
        if (finalPacking.length === 0) finalPacking = parseArrayField(sys.packing_list);
        if (finalHotels.length === 0) finalHotels = parseArrayField(sys.hotels);

        // Galleri: alltid bruk systemets galleri hvis det finnes
        const g = parseArrayField(sys.gallery);
        if (g.length > 0) finalGallery = g;

        // Experiences: bruk systemets hvis klienten ikke har sendt
        if (finalExperiences.length === 0) {
          finalExperiences = parseArrayField(sys.experiences);
        }
      }

      // Hvis episode-reise fortsatt mangler stops → avvis tydelig (siden kartet blir tomt uansett)
      if (finalStops.length === 0) {
        return res.status(400).json({
          error:
            "Episode-reise mangler stops. Fant heller ingen system-trip å kopiere stops fra."
        });
      }
    } else {
      // ---------------- Vanlige KI / scratch-reiser ----------------
      sourceType = source_type || null;

      // For vanlige reiser må klient sende stops
      if (finalStops.length === 0) {
        return res.status(400).json({
          error: "Mangler stops (array) i request body."
        });
      }

      if (finalGallery.length === 0) {
        finalGallery = await generateGalleryForTrip(title, description, finalStops);
      }
    }

    const isHttpUrl = (s) => {
      if (typeof s !== "string") return false;
      const t = s.trim();
      return /^https?:\/\/\S+/i.test(t);
    };

    // Bedre enn maps for hotell: søk "hotel + sted" (funner alltid noe)
    function makeHotelFallbackUrl(h) {
      const name = (h?.name || h?.title || "").toString().trim();
      const location = (h?.location || h?.city || h?.area || "").toString().trim();
      if (!name) return null;
          
      const q = encodeURIComponent(location ? `${name} ${location} hotell` : `${name} hotell`);
      return `https://www.google.com/search?q=${q}`;
    }
      
    finalHotels = finalHotels.map((h) => {
      const cleaned = sanitizeUrl(h?.url);
      return {
        ...h,
        url: cleaned || makeHotelFallbackUrl(h) // ✅ alltid noe brukbart
      };
    });
      
    finalExperiences = finalExperiences.map(e => ({
      ...e,
      url:
        sanitizeUrl(e?.booking_url || e?.url || e?.ticket_url || e?.link || e?.external_url) ||
        makeExperienceFallbackUrl(e)
    }));
      
    // ---------------- Lagre i database ----------------
    const insert = await query(
      `
      INSERT INTO trips (
        user_id,
        title,
        description,
        stops,
        packing_list,
        hotels,
        source_type,
        source_episode_id,
        gallery,
        episode_url,
        experiences
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        req.user.id, // $1
        title, // $2
        description ? String(description) : null, // $3
        JSON.stringify(finalStops), // $4
        JSON.stringify(finalPacking), // $5
        JSON.stringify(finalHotels), // $6
        sourceType, // $7
        source_episode_id || null, // $8
        JSON.stringify(finalGallery), // $9
        episode_url || null, // $10
        JSON.stringify(finalExperiences) // $11
      ]
    );

    const row = insert.rows[0];

    return res.status(201).json({
      ok: true,
      trip: {
        ...row,
        // Returnér normalisert struktur (så appen får coords med en gang)
        stops: finalStops,
        packing_list: finalPacking,
        hotels: finalHotels,
        gallery: finalGallery,
        experiences: finalExperiences
      }
    });
  } catch (e) {
    console.error("/api/trips POST-feil:", e);
    return res.status(500).json({ error: "Kunne ikke opprette reise." });
  }
});

app.post(
  "/api/trips/:id/delete",
  authMiddleware,
  async (req, res) => {
    try {
      const tripId = req.params.id;
      const userId = req.user.id;

      // 1) Finn reisen først
      const checkRes = await query(
        `
        SELECT id, source_type
        FROM trips
        WHERE id = $1 AND user_id = $2
        `,
        [tripId, userId]
      );

      if (checkRes.rowCount === 0) {
        return res.status(404).json({ error: "Reise ikke funnet." });
      }

      const trip = checkRes.rows[0];

      // 2) Ikke tillat sletting av Grenseløs-systemreiser (de som eier galleriet)
      if (trip.source_type === "grenselos_episode") {
        return res.status(403).json({
          error:
            "Denne reisen er en systemreise for Grenseløs-episoder og kan ikke slettes, fordi den også inneholder galleribilder brukt i Admin."
        });
      }

      // 3) Slett vanlige brukerreiser
      const result = await query(
        `DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING id`,
        [tripId, userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Reise ikke funnet." });
      }

      res.json({ success: true, deletedId: tripId });
    } catch (e) {
      console.error("/api/trips/:id/delete-feil:", e);
      res.status(500).json({ error: "Kunne ikke slette reise." });
    }
  }
);

app.post(
  "/api/billing/vipps/mark-premium",
  async (req, res) => {
    try {
      // Bruk *egentlig* signatur/secret for å verifisere at dette kommer fra Vipps.
      const { userId } = req.body || {};

      if (!userId) {
        return res.status(400).json({ error: "Mangler userId." });
      }

      const result = await query(
        `
        UPDATE users
        SET is_premium = TRUE
        WHERE id = $1
        RETURNING id, email, is_premium
        `,
        [userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Bruker ikke funnet." });
      }

      res.json({ ok: true, user: result.rows[0] });
    } catch (e) {
      console.error("/api/billing/vipps/mark-premium-feil:", e);
      res.status(500).json({ error: "Kunne ikke markere bruker som premium." });
    }
  }
);

// -------------------------------------------------------
//  TEMPLATES (JA)
// -------------------------------------------------------

app.get("/api/templates", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT * FROM trips
      WHERE user_id=$1 AND source_type='template'
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const templates = result.rows.map((row) => {
      let stops = row.stops;
      if (typeof stops === "string") try { stops = JSON.parse(stops); } catch {}
      return { ...row, stops };
    });

    res.json({ templates });
  } catch (e) {
    console.error("/api/templates GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente templates." });
  }
});

// -------------------------------------------------------
//  SYNC AV EPISODER TIL TRIPS (NYTT)
// -------------------------------------------------------

app.post(
  "/api/grenselos/sync-all-episodes",
  authMiddleware,
  async (req, res) => {
    try {
      // 1) Hent ALLE episoder (inkl. paginering)
      const episodes = await fetchGrenselosEpisodes();
      const totalEpisodes = Array.isArray(episodes) ? episodes.length : 0;

      console.log(
        `[sync-all-episodes] Fant totalt ${totalEpisodes} episoder fra Spotify`
      );

      // 2) Opprett/oppdater alle trips
      const ids = [];
      for (const ep of episodes) {
        const id = await ensureTripForEpisode(ep, req.user.id);
        ids.push(id);
      }

      console.log(
        `[sync-all-episodes] Opprettet/oppdatert totalt ${ids.length} podkast-reiser`
      );

      // 3) Returner resultatet med mer info
      res.json({
        ok: true,
        count: ids.length,
        tripIds: ids,
        totalEpisodes  // 👈 Nytt felt!
      });
    } catch (e) {
      console.error("sync-all-episodes-feil:", e);
      res.status(500).json({
        error: "Kunne ikke analysere alle episoder."
      });
    }
  }
);

// ---------- Spotify: hent alle Grenseløs-episoder (med paginering) ----------

app.get('/api/grenselos/episodes', async (req, res) => {
  try {
    const token = await getSpotifyAccessToken();
    const showId = process.env.SPOTIFY_SHOW_ID;

    if (!showId) {
      return res
        .status(500)
        .json({ error: 'SPOTIFY_SHOW_ID er ikke satt i .env' });
    }

    const allItems = [];
    let url = `https://api.spotify.com/v1/shows/${showId}/episodes`;
    let params = {
      market: 'NO',
      limit: 50,
      offset: 0
    };

    // Paginer til det ikke finnes flere sider
    while (url) {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        params
      });

      const data = response.data;
      allItems.push(...(data.items || []));

      if (data.next) {
        // Spotify gir full next-URL, så vi bruker den og dropper params
        url = data.next;
        params = undefined;
      } else {
        url = null;
      }
    }

    // Mapper alle episodene til det formatet appen bruker
    const episodes = allItems.map((ep) => ({
      id: ep.id,
      name: ep.name,
      description: ep.description,
      release_date: ep.release_date,
      audio_url: ep.audio_preview_url || null,
      external_url: ep.external_urls?.spotify || null,
      image: ep.images?.[0]?.url || null,
      duration_ms: ep.duration_ms
    }));

    // Hvis du vil ha dem i kronologisk rekkefølge (eldst → nyest):
    episodes.sort((a, b) => {
      if (!a.release_date || !b.release_date) return 0;
      return a.release_date.localeCompare(b.release_date);
    });

    res.json({ episodes });
  } catch (err) {
    console.error(
      'Feil ved henting av Spotify-episoder (med paginering):',
      err?.response?.data || err
    );
    res.status(500).json({ error: 'Kunne ikke hente episoder' });
  }
});

// ----------------------------------------------------------------------
// ✅ PREVIEW: Analyser episode -> lag trip (MEN IKKE lagre i DB)
// POST /api/grenselos/episodes/:id/analyze
// Body: { name, description, userPreferences?, useProfile?, episode_url? }
// Return: { ok:true, trip, raw, entitlement }
// ----------------------------------------------------------------------
app.post(
  "/api/grenselos/episodes/:id/analyze",
  authMiddleware,
  async (req, res) => {
    try {
      const episodeId = (req.params.id || "").toString().trim();

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim()
          : "";
      const userPreferences =
        typeof req.body?.userPreferences === "string"
          ? req.body.userPreferences.trim()
          : "";

      const useProfile = req.body?.useProfile !== false; // default true
      const episodeUrl =
        typeof req.body?.episode_url === "string" && req.body.episode_url.trim()
          ? req.body.episode_url.trim()
          : null;

      if (!episodeId) {
        return res.status(400).json({ error: "Mangler episode-id i URL." });
      }
      if (!name || !description) {
        return res.status(400).json({
          error: "Mangler name eller description i request body.",
        });
      }

      // 🔑 Premium/admin: detaljer kan vises (paywall på hoteller/pakkeliste/opplevelser)
      const detailsUnlocked = !!(req.user?.is_admin || req.user?.is_premium);

      // ---------------- Helpers ----------------
      const parseJsonArray = (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      const isHttpUrl = (s) => {
        if (typeof s !== "string") return false;
        const t = s.trim();
        return /^https?:\/\/\S+/i.test(t);
      };

      const sanitizeUrl = (s) => (isHttpUrl(s) ? s.trim() : null);

      const makeHotelFallbackUrl = (h) => {
        const name = (h?.name || h?.title || "").toString().trim();
        const location = (h?.location || h?.city || h?.area || "")
          .toString()
          .trim();
        if (!name) return null;
        const q = encodeURIComponent(location ? `${name} ${location}` : name);
        return `https://www.google.com/maps/search/?api=1&query=${q}`;
      };

      const makeExperienceFallbackUrl = (x) => {
        const name = (x?.name || x?.title || "").toString().trim();
        const location = (x?.location || x?.city || x?.area || "")
          .toString()
          .trim();
        if (!name) return null;
        const q = encodeURIComponent(
          location ? `${name} ${location} billetter` : `${name} billetter`
        );
        return `https://www.google.com/search?q=${q}`;
      };

      // 1) Hent profil hvis ønsket
      let userProfile = null;
      if (useProfile) {
        try {
          const profRes = await query(
            `
            SELECT full_name, home_city, home_country, birth_year, travel_style, budget_per_day, experience_level
            FROM users
            WHERE id = $1
            LIMIT 1
            `,
            [req.user.id]
          );
          userProfile = profRes.rows?.[0] || null;
        } catch (e) {
          // Profil er optional – ikke fail hele request
          console.warn(
            "Kunne ikke hente profil (fortsetter uten):",
            e?.message || e
          );
          userProfile = null;
        }
      }

      // 2) Generer trip fra episode (IKKE lagre)
      const { trip: generatedTrip, raw } = await generateTripFromEpisode({
        episodeId,
        name,
        description,
        userPreferences,
        userProfile,
      });

      const baseTrip =
        generatedTrip && typeof generatedTrip === "object"
          ? generatedTrip
          : {
              title: name || "Reise fra episode",
              description: null,
              stops: [],
              packing_list: [],
              hotels: [],
              experiences: [],
              gallery: [],
            };

      // 3) Normaliser felter slik klienten alltid får riktig format
      const stops = parseJsonArray(baseTrip.stops);
      const gallery = parseJsonArray(baseTrip.gallery);

      const normalizedHotels = parseJsonArray(baseTrip.hotels)
        .filter((h) => h && typeof h === "object")
        .map((h) => ({
          ...h,
          url:
            sanitizeUrl(h?.url) ||
            sanitizeUrl(h?.booking_url) ||
            sanitizeUrl(h?.link) ||
            sanitizeUrl(h?.external_url) ||
            makeHotelFallbackUrl(h),
        }));

      const normalizedExperiences = parseJsonArray(baseTrip.experiences)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          ...x,
          url:
            sanitizeUrl(x?.url) ||
            sanitizeUrl(x?.booking_url) ||
            sanitizeUrl(x?.ticket_url) ||
            sanitizeUrl(x?.link) ||
            sanitizeUrl(x?.external_url) ||
            makeExperienceFallbackUrl(x),
        }));

      const normalizedPacking = normalizePackingForClient(baseTrip.packing_list);

      // 4) Bygg preview-trip + paywall på detaljer (ikke på antall turer)
      const locked = !detailsUnlocked;

      const previewTrip = {
        ...baseTrip,

        // viktig: ingen "id" her, siden den ikke er lagret
        id: undefined,

        title: baseTrip.title || name || "Reise fra episode",
        stops,
        gallery,

        source_type: "user_episode_trip_preview",
        source_episode_id: episodeId,
        episode_url: episodeUrl,

        // 🔒 Lås detaljene hvis ikke premium/admin
        hotels: locked ? [] : normalizedHotels,
        experiences: locked ? [] : normalizedExperiences,
        packing_list: locked ? [] : normalizedPacking,

        details_locked: locked,
        details_preview: locked
          ? {
              hotels_count: normalizedHotels.length,
              experiences_count: normalizedExperiences.length,
              packing_categories: (normalizedPacking || [])
                .map((g) => g?.category)
                .filter(Boolean)
                .slice(0, 6),
            }
          : null,
      };

      // 5) Returner preview
      return res.json({
        ok: true,
        trip: previewTrip,
        raw: raw || null,
        entitlement: {
          details_unlocked: detailsUnlocked,
          is_premium: !!req.user?.is_premium,
          is_admin: !!req.user?.is_admin,
        },
      });
    } catch (err) {
      console.error(
        "/api/grenselos/episodes/:id/analyze (preview) feil:",
        err
      );
      return res
        .status(500)
        .json({ error: "Kunne ikke analysere episoden." });
    }
  }
);

app.post("/api/ai/generate-gallery", authMiddleware, async (req, res) => {
  try {
    const { title, description, stops } = req.body || {};

    const gallery = await generateGalleryForTrip(
      title || null,
      description || null,
      stops || []
    );

    return res.json({ gallery });
  } catch (err) {
    console.error("❌ /api/ai/generate-gallery:", err);
    return res.status(500).json({ error: "Kunne ikke generere galleri." });
  }
});


// -------------------------------------------------------
//  COMMUNITY (API som matcher appen)
// -------------------------------------------------------

// Kategorier
app.get("/api/community/categories", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name FROM community_categories ORDER BY name ASC`
    );
    res.json({ categories: result.rows });
  } catch (e) {
    console.error("/api/community/categories GET error:", e);
    res.status(500).json({ error: "Kunne ikke hente kategorier." });
  }
});

// Liste (feed)
app.get("/api/community/posts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `
      SELECT
        p.id,
        p.user_id,
        COALESCE(p.user_name, u.full_name, 'Ukjent bruker') AS author_name,
        p.title,
        p.text AS content,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        p.answer,
        p.answered_at,
        EXISTS(
          SELECT 1
          FROM community_likes l
          WHERE l.post_id = p.id AND l.user_id = $1
        ) AS liked_by_me
      FROM community_posts p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN community_categories c ON c.id = p.category_id
      ORDER BY p.created_at DESC
      `,
      [userId]
    );

    const posts = result.rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      author_name: r.author_name,
      title: r.title || "Innlegg",
      content: r.content || "",
      created_at: r.created_at,
      category_id: r.category_id,
      category_name: r.category_name || null,
      images: Array.isArray(r.images) ? r.images : [],
      likes: Number(r.likes || 0),
      likedByMe: !!r.liked_by_me,
      answer: r.answer || null,
      answered_at: r.answered_at || null
    }));

    res.json({ posts });
  } catch (e) {
    console.error("/api/community/posts GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente community-poster." });
  }
});

// Detail (brukes av CommunityPostDetailScreen)
app.get("/api/community/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // behold som string/int, ikke tving Number
    const postId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    const result = await query(
      `
      SELECT
        p.id,
        p.user_id,
        COALESCE(p.user_name, u.full_name, 'Ukjent bruker') AS author_name,
        p.title,
        p.text AS content,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        p.answer,
        p.answer_by,
        p.answered_at,
        EXISTS(
          SELECT 1
          FROM community_likes l
          WHERE l.post_id = p.id AND l.user_id = $1
        ) AS liked_by_me
      FROM community_posts p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN community_categories c ON c.id = p.category_id
      WHERE p.id = $2
      LIMIT 1
      `,
      [userId, postId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Post ikke funnet." });
    }

    const r = result.rows[0];

    res.json({
      post: {
        id: r.id,
        user_id: r.user_id,
        author_name: r.author_name,
        title: r.title || "Innlegg",
        content: r.content || "",
        created_at: r.created_at,
        category_id: r.category_id,
        category_name: r.category_name || null,
        images: Array.isArray(r.images) ? r.images : [],
        likes: Number(r.likes || 0),
        likedByMe: !!r.liked_by_me,
        answer: r.answer || null,
        answer_by: r.answer_by || null,
        answered_at: r.answered_at || null
      }
    });
  } catch (e) {
    console.error("/api/community/posts/:id GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente innlegget." });
  }
});

// Opprett post (matcher CommunityNewPostScreen)
app.post("/api/community/posts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { title, body, text, content, message, category_id, images } = req.body || {};
    console.log("POST /api/community/posts req.body =", req.body);

    const pickText = (...vals) =>
      vals.find((v) => typeof v === "string" && v.trim())?.trim() || "";

    const finalTitle = pickText(title);
    const finalBody  = pickText(body, text, content, message);

    if (!finalBody) {
      return res.status(400).json({ error: "Tekst kan ikke være tom." });
    }

    // Hent visningsnavn
    const userRes = await query(`SELECT full_name FROM users WHERE id=$1`, [userId]);
    const userName = userRes.rows[0]?.full_name || "Ukjent bruker";

    // ✅ category_id → number | null (robust)
    const categoryIdValue =
      typeof category_id === "number"
        ? category_id
        : typeof category_id === "string" && /^\d+$/.test(category_id)
          ? Number(category_id)
          : null;

    // ✅ images → string[] (robust)
    const normalizeUrl = (u) => {
      if (typeof u !== "string") return null;
      const s = u.trim();
      if (!s) return null;

      // Tillat både relative (/uploads/..) og full URL
      if (s.startsWith("/uploads/")) return s;
      if (/^https?:\/\/\S+$/i.test(s)) return s;

      return null;
    };

    let imagesValue = [];

    if (Array.isArray(images)) {
      imagesValue = images.map(normalizeUrl).filter(Boolean);
    } else if (typeof images === "string") {
      const one = normalizeUrl(images);
      if (one) imagesValue = [one];
    } else if (images && Array.isArray(images.urls)) {
      imagesValue = images.urls.map(normalizeUrl).filter(Boolean);
    }

    console.log("DEBUG community insert:", {
      userId,
      finalTitle,
      finalBody,
      categoryIdValue,
      imagesCount: imagesValue.length,
      imagesSample: imagesValue.slice(0, 2)
    });

    const insert = await query(
      `
      INSERT INTO community_posts (user_id, user_name, title, text, category_id, images)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        userId,
        userName,
        finalTitle || null,
        finalBody,
        categoryIdValue,
        imagesValue
      ]
    );

    const row = insert.rows[0];

    return res.json({
      post: {
        id: row.id,
        user_id: row.user_id,
        author_name: row.user_name || userName,
        title: row.title || "Innlegg",
        content: row.text,
        created_at: row.created_at,
        category_id: row.category_id,
        images: Array.isArray(row.images) ? row.images : [],
        likes: Number(row.likes || 0),
        likedByMe: false,
        answer: row.answer || null,
        answered_at: row.answered_at || null
      }
    });
  } catch (e) {
    console.error("/api/community/posts POST error:", e);
    return res.status(500).json({ error: "Kunne ikke lage community-post." });
  }
});

// ✅ Updated: /api/trips/:id/hotels
// - Datoer legges inn av bruker i appen (ikke i DB)
// - Destinasjon kommer fra stops[0] (stopp 1)
// - Gratis: preview (uten url). Pro: full + url
// - Episode-trips: canonical hotels fra siste trips-row med source_type='grenselos_episode'

function asArrayJsonb(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  // pg kan gi jsonb som objekt/string avhengig av client/oppsett
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  // jsonb-objekt
  return Array.isArray(v) ? v : [];
}

// Forsøk å hente en "destinasjon" fra stop 1 på tvers av mulige stop-skjema
function extractDestinationFromStop1(stops) {
  const arr = asArrayJsonb(stops);
  const s0 = arr[0];
  if (!s0 || typeof s0 !== "object") return null;

  // typiske felter jeg har sett i slike stops:
  const name =
    s0.name ||
    s0.title ||
    s0.place_name ||
    s0.placeName ||
    s0.label ||
    s0.city ||
    s0.locationName ||
    null;

  const country = s0.country || s0.countryName || null;

  // iata kan ligge flere steder
  const iata =
    s0.iata ||
    s0.city_iata ||
    s0.destination_iata ||
    s0.airport_iata ||
    s0.airportIata ||
    (s0.airport && (s0.airport.iata || s0.airport.IATA)) ||
    null;

  const lat =
    (typeof s0.lat === "number" && s0.lat) ||
    (typeof s0.latitude === "number" && s0.latitude) ||
    (typeof s0.coords?.lat === "number" && s0.coords.lat) ||
    (typeof s0.coordinate?.latitude === "number" && s0.coordinate.latitude) ||
    null;

  const lng =
    (typeof s0.lng === "number" && s0.lng) ||
    (typeof s0.lon === "number" && s0.lon) ||
    (typeof s0.longitude === "number" && s0.longitude) ||
    (typeof s0.coords?.lng === "number" && s0.coords.lng) ||
    (typeof s0.coords?.lon === "number" && s0.coords.lon) ||
    (typeof s0.coordinate?.longitude === "number" && s0.coordinate.longitude) ||
    null;

  return {
    name: name ? String(name) : null,
    country: country ? String(country) : null,
    iata: iata ? String(iata).trim().toUpperCase() : null,
    lat,
    lng,
    raw: s0, // nyttig for debugging i admin, kan fjernes
  };
}

app.get("/api/trips/:id/hotels", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    // 1) Hent trip (kun eier)
    const tripRes = await query(
      `
      SELECT id, user_id, title, stops, hotels, source_type, source_episode_id, episode_url
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    // 2) Start med tripens egne hoteller
    let hotels = parseJsonArray(row.hotels);

    // 3) episode-trip: canonical hotels fra SYSTEM (grenselos_episode)
    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT hotels
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) {
        hotels = parseJsonArray(canonRes.rows[0].hotels);
      }
    }

    // 4) Normaliser + url kun for Pro
    const hotelsFull = (hotels || [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        ...h,
        url: isPro ? makeHotelUrl(h) : undefined,
      }));

    const hotelsPreview = hotelsFull.slice(0, 10).map((h) => ({
      name: h?.name || h?.title || "Hotell",
      location: h?.location || h?.city || h?.area || null,
      // url skal ikke være med i preview
    }));

    // 5) Destinasjon fra stop 1
    const destination = extractDestinationFromStop1(row.stops);

    return res.json({
      ok: true,
      tripId,
      destination, // { name, country, iata, lat, lng, raw }
      hotels: isPro ? hotelsFull : hotelsPreview,
      entitlements: { isPro, locked: { hotels: !isPro } },
      counts: { hotels: hotelsFull.length },
      // valgfritt: for klient-debug
      source: {
        source_type: row.source_type || null,
        source_episode_id: row.source_episode_id || null,
        episode_url: row.episode_url || null,
      },
    });
  } catch (e) {
    console.error("/api/trips/:id/hotels-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente hoteller." });
  }
});

app.get("/api/trips/:id/experiences", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    const tripRes = await query(
      `SELECT id, source_episode_id, source_type, experiences, stops
       FROM trips
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let experiences = parseJsonArray(row.experiences);

    // episode-trip: hent canonical experiences
    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT experiences
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) {
        experiences = parseJsonArray(canonRes.rows[0].experiences);
      }
    }

    // Full liste (pro)
    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) })); // hvis du har den helperen

    // Teaser (gratis)
    const experiencesPreview = experiencesFull.slice(0, 3).map((x) => ({
      name: x?.name || x?.title || "Opplevelse",
      location: x?.location || x?.city || x?.area || null,
      description: x?.description || null,
      // IKKE url til gratis
    }));

    return res.json({
      ok: true,
      tripId,
      experiences: isPro ? experiencesFull : experiencesPreview,
      entitlements: { isPro, locked: { experiences: !isPro } },
      counts: { experiences: experiencesFull.length },
    });
  } catch (e) {
    console.error("/api/trips/:id/experiences-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente opplevelser." });
  }
});

app.get("/api/trips/:id/packing-list", authMiddleware, requirePro, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await query(
      `SELECT id, source_episode_id, packing_list
       FROM trips
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let packing = row.packing_list;

    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT packing_list
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) {
        packing = canonRes.rows[0].packing_list;
      }
    }

    const packingFull = normalizePackingForClient(packing);

    return res.json({ ok: true, tripId, packing_list: packingFull });
  } catch (e) {
    console.error("/api/trips/:id/packing-list-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente pakkeliste." });
  }
});

// Like/unlike
app.post("/api/community/posts/:id/like", authMiddleware, async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const userId = req.user.id;

    const exists = await query(
      `SELECT 1 FROM community_likes WHERE user_id=$1 AND post_id=$2`,
      [userId, postId]
    );

    if (exists.rowCount > 0) {
      await query(
        `DELETE FROM community_likes WHERE user_id=$1 AND post_id=$2`,
        [userId, postId]
      );
      await query(
        `UPDATE community_posts SET likes = GREATEST(likes - 1, 0) WHERE id=$1`,
        [postId]
      );
      return res.json({ liked: false });
    }

    await query(
      `INSERT INTO community_likes (user_id, post_id) VALUES ($1,$2)`,
      [userId, postId]
    );
    await query(
      `UPDATE community_posts SET likes = likes + 1 WHERE id=$1`,
      [postId]
    );

    res.json({ liked: true });
  } catch (e) {
    console.error("/api/community/posts/:id/like error:", e);
    res.status(500).json({ error: "Kunne ikke oppdatere like." });
  }
});

// Admin: svar
app.post(
  "/api/community/posts/:id/answer",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { answer } = req.body || {};

      if (!answer || !answer.trim()) {
        return res.status(400).json({ error: "Svaret kan ikke være tomt." });
      }

      const update = await query(
        `
        UPDATE community_posts
        SET answer=$1, answer_by=$2, answered_at=NOW()
        WHERE id=$3
        RETURNING *
        `,
        [answer.trim(), "Johnny", postId]
      );

      if (update.rowCount === 0) {
        return res.status(404).json({ error: "Post ikke funnet." });
      }

      const row = update.rows[0];
      res.json({
        post: {
          id: row.id,
          answer: row.answer,
          answer_by: row.answer_by,
          answered_at: row.answered_at
        }
      });
    } catch (e) {
      console.error("/api/community/posts/:id/answer error:", e);
      res.status(500).json({ error: "Kunne ikke lagre svar." });
    }
  }
);

// -------------------------------------------------------
//  COMMUNITY: BILDEOPPLASTING (for innlegg)
// -------------------------------------------------------

app.post(
  "/api/community/uploads",
  authMiddleware,
  upload.array("images", 10),
  async (req, res) => {
    try {
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({ error: "Ingen bildefiler ble lastet opp." });
      }

      // Returner relative URL-er som funker mot samme backend-baseURL
      const urls = files.map((f) => `/uploads/${f.filename}`);

      res.json({ ok: true, urls });
    } catch (e) {
      console.error("/api/community/uploads-feil:", e);
      res.status(500).json({ error: "Kunne ikke laste opp bilder." });
    }
  }
);

app.delete("/api/community/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: "Ikke innlogget." });
    }

    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    // 🔐 admin?
    const u = await query(`SELECT is_admin FROM users WHERE id=$1`, [userId]);
    if (!u.rows.length) {
      return res.status(401).json({ error: "Bruker finnes ikke." });
    }
    const isAdmin = u.rows[0].is_admin === true;

    // 📄 post?
    const p = await query(`SELECT id, user_id FROM community_posts WHERE id=$1`, [postId]);
    const post = p.rows[0];
    if (!post) {
      return res.status(404).json({ error: "Innlegg finnes ikke." });
    }

    const isOwner = post.user_id === userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Ikke tilgang til å slette dette innlegget." });
    }

    await query(`DELETE FROM community_posts WHERE id=$1`, [postId]);

    return res.json({ ok: true });
    // evt: return res.status(204).send();
  } catch (e) {
    console.error("/api/community/posts/:id DELETE error:", e);
    return res.status(500).json({ error: "Kunne ikke slette innlegg." });
  }
});

// -------------------------------------------------------
//  AVIASALES / TRAVELPAYOUTS – FLIGHTS + LOCATIONS (index.js)
// -------------------------------------------------------

function normalizeAbsoluteUrl(u) {
  if (!u) return "";
  let s = String(u).trim();

  // fjern trailing slashes
  s = s.replace(/\/+$/, "");

  // allerede absolutt
  if (/^https?:\/\//i.test(s)) return s;

  // //example.com/...
  if (s.startsWith("//")) return ("https:" + s).replace(/\/+$/, "");

  // hvis den starter med / så er det en path – her vet vi ikke hosten sikkert,
  // men Travelpayouts skal normalt gi en host. Vi lar den feile tydelig.
  if (s.startsWith("/")) return "";

  // host uten scheme -> legg på https://
  return ("https://" + s).replace(/\/+$/, "");
}

import {
  travelpayoutsConfig as tp,
  makeSignature,
  makeHeaders,
} from "./src/config/travelpayouts.js";

// Cache (in-memory) searchId -> results_url (MVP). Bytt til DB/Redis senere.
const flightSearchCache = new Map();

// TP endpoint: start search
const TP_START_URL =
  "https://tickets-api.travelpayouts.com/search/affiliate/start";

// Debug ved oppstart
console.log("✈️ Travelpayouts config:", {
  hasToken: !!tp?.token,
  hasMarker: !!tp?.marker,
  hasRealHost: !!tp?.realHost,
  lang: tp?.lang,
});

if (!tp?.token || !tp?.marker || !tp?.realHost) {
  console.warn(
    "⚠️ Mangler Travelpayouts config. Sett TRAVELPAYOUTS_TOKEN, TRAVELPAYOUTS_MARKER og TRAVELPAYOUTS_REAL_HOST."
  );
}

// -------------------------
// START – /api/flights/start
// Body: { segments:[{origin,destination,date}], passengers:{adults,children,infants}, currency, locale, trip_class }
// -------------------------
app.post("/api/flights/start", async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res.status(500).json({
        error:
          "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_TOKEN / TRAVELPAYOUTS_MARKER mangler)",
      });
    }
    if (!tp?.realHost) {
      return res.status(500).json({
        error:
          "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_REAL_HOST mangler)",
      });
    }

    const body = req.body || {};
    const segments = Array.isArray(body.segments) ? body.segments : [];

    const directions = segments
      .map((s) => ({
        origin: String(s?.origin || "").trim().toUpperCase(),
        destination: String(s?.destination || "").trim().toUpperCase(),
        date: String(s?.date || "").trim(), // YYYY-MM-DD
      }))
      .filter((d) => d.origin && d.destination && d.date);

    if (!directions.length) {
      return res.status(400).json({
        error: "Minst ett segment kreves (origin, destination, date)",
      });
    }

    if (directions.some((d) => d.origin === d.destination)) {
      return res.status(400).json({
        error: "origin og destination kan ikke være like",
      });
    }

    const passengers = body.passengers || {};
    const adults = Number(passengers.adults ?? 1);
    const children = Number(passengers.children ?? 0);
    const infants = Number(passengers.infants ?? 0);

    if (
      !Number.isFinite(adults) ||
      adults < 1 ||
      !Number.isFinite(children) ||
      children < 0 ||
      !Number.isFinite(infants) ||
      infants < 0 ||
      infants > adults
    ) {
      return res.status(400).json({ error: "Ugyldig passasjer-oppsett" });
    }

    // Travelpayouts payload-kontrakt
    const payload = {
      marker: tp.marker,
      locale: body.locale || "no",
      currency_code: body.currency || "NOK",
      market_code: body.market_code || "NO",
      search_params: {
        trip_class: String(body.trip_class || "Y").toUpperCase(),
        passengers: { adults, children, infants },
        directions,
      },
    };

    const signature = makeSignature(tp.token, payload);
      
    const response = await axios.post(
      TP_START_URL,
      { ...payload, signature },
      {
        headers: makeHeaders(req, signature, tp),
        timeout: 15000,
      }
    );

    const searchId = response.data?.search_id;
    const resultsUrl = response.data?.results_url;

    if (!searchId || !resultsUrl) {
      return res.status(502).json({
        error:
          "Ugyldig svar fra Travelpayouts (mangler search_id/results_url)",
        details: response.data || null,
      });
    }

    const normalizedResultsUrl = normalizeAbsoluteUrl(resultsUrl);

    if (!normalizedResultsUrl) {
      return res.status(502).json({
        error: "Ugyldig results_url fra Travelpayouts (ikke absolutt URL)",
        details: { resultsUrl },
      });
    }

    flightSearchCache.set(String(searchId), {
      results_url: normalizedResultsUrl,
      created_at: Date.now(),
    });
      
    return res.json({
      ok: true,
      search_id: String(searchId),
      results_url: String(resultsUrl),
    });
  } catch (err) {
    console.error(
      "❌ /api/flights/start feilet:",
      err?.response?.data || err?.message || err
    );
    return res.status(502).json({
      error: "Upstream start failed",
      details: err?.response?.data || null,
    });
  }
});

// Anbefalt global cache for click-mapping (sid -> Map(offer_id -> click_id))
const flightClickCache = global.flightClickCache || (global.flightClickCache = new Map());

// ==============================
// ✅ /api/flights/results (FIX v2 + airline/flightno robust)
// - segments[].flights kan være:
//    A) id/uuid -> legsById
//    B) index (number) -> data.flight_legs[idx]  ✅ (hos deg: [82,83,84])
// - fyller depTime/arrTime/routeText/durationText/stopsText/airlinesText/flightNosText
// - 304 returnerer offers:null
// ==============================
app.post("/api/flights/results", async (req, res) => {
  try {
    const { search_id, last_update_timestamp = 0 } = req.body || {};
    const sid = String(search_id || "").trim();
    const tsIn = Number(last_update_timestamp) || 0;

    console.log("➡️ /api/flights/results called", { sid, tsIn });

    if (!tp?.token || !tp?.marker) {
      return res.status(500).json({
        error:
          "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_TOKEN / TRAVELPAYOUTS_MARKER mangler)",
      });
    }
    if (!tp?.realHost) {
      return res.status(500).json({
        error: "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_REAL_HOST mangler)",
      });
    }
    if (!sid) return res.status(400).json({ error: "Mangler search_id" });

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt)." });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({
        error: "Cached results_url er ugyldig",
        details: { cached_results_url: cached.results_url },
      });
    }

    const resultsUrl = new URL("/search/affiliate/results", base).toString();

    const payload = { marker: tp.marker, search_id: sid, last_update_timestamp: tsIn };
    const signature = makeSignature(tp.token, tp.marker, payload);

    console.log("🔎 TP results:", { resultsUrl, sid, tsIn });

    const r = await axios.post(
      resultsUrl,
      { ...payload, signature },
      {
        headers: makeHeaders(req, signature, tp),
        timeout: 20000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      }
    );

    console.log("✅ TP status:", r.status);

    if (r.status === 304) {
      console.log("ℹ️ TP 304 (no new data)", { sid, tsIn });
      return res.json({
        ok: true,
        is_over: false,
        last_update_timestamp: tsIn,
        offers: null, // 👈 viktig: ikke overskriv i app
      });
    }

    const data = r.data || {};
    const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
    const legsArr = Array.isArray(data?.flight_legs) ? data.flight_legs : [];

    const tpRawTs =
      typeof data.last_update_timestamp === "number"
        ? data.last_update_timestamp
        : typeof data.last_update_timestamp === "string"
        ? Number(data.last_update_timestamp) || 0
        : 0;

    const tpTs = Math.max(tsIn, tpRawTs || 0);
    const isOver = !!data.is_over;

    // ---------------- helpers ----------------
    const pick = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        if (v != null && v !== "") return v;
      }
      return null;
    };

    const toUpper = (v) => String(v || "").toUpperCase().trim();

    const num = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim()) {
        const n = Number(v.replace(",", "."));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const fmtTimeHHMM = (v) => {
      if (!v) return "";
      const s = String(v);
      if (s.includes("T")) return s.split("T")[1]?.slice(0, 5) || "";
      if (s.includes(" ")) return s.split(" ")[1]?.slice(0, 5) || "";
      return s.slice(0, 5);
    };

    const fmtDurationMins = (mins) => {
      const n = Number(mins);
      if (!Number.isFinite(n)) return "";
      const h = Math.floor(n / 60);
      const m = n % 60;
      return h > 0 ? `${h}t ${m}m` : `${m}m`;
    };

    const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

    // proposals: price kan være objekt {currency, amount}
    const pickPriceFromProposal = (p) => {
      const c = p?.price ?? p?.unified_price ?? p?.total_price ?? p?.amount ?? null;
      if (typeof c === "number" && Number.isFinite(c)) return c;
      if (typeof c === "string") return num(c);
      if (c && typeof c === "object") return num(c.amount ?? c.value ?? c.price ?? c.total);
      return null;
    };

    const pickCurrency = (p, t) => {
      const c =
        (typeof p?.price === "object" ? p.price?.currency : null) ||
        (typeof p?.unified_price === "object" ? p.unified_price?.currency : null) ||
        (typeof p?.price_per_person === "object" ? p.price_per_person?.currency : null) ||
        p?.currency ||
        t?.currency ||
        data?.search_params?.currency_code ||
        data?.search_params?.currency ||
        "NOK";
      return toUpper(c || "NOK");
    };

    // ---------------- build legsById + resolveLeg ----------------
    const legsById = new Map();
    for (const leg of legsArr) {
      const id =
        leg?.id ??
        leg?._id ??
        leg?.uuid ??
        leg?.leg_id ??
        leg?.flight_leg_id ??
        leg?.flight_id ??
        null;
      if (id != null) legsById.set(String(id), leg);
    }

    // ✅ flights[] kan være indeks ELLER id
    const resolveLeg = (ref) => {
      if (ref == null) return null;
      if (typeof ref === "object") return ref;

      // 1) id-lookup
      const byId = legsById.get(String(ref));
      if (byId) return byId;

      // 2) index-lookup (vanlig når flights = [82,83,84])
      const idx = typeof ref === "number" ? ref : Number(ref);
      if (Number.isInteger(idx) && idx >= 0 && idx < legsArr.length) return legsArr[idx];

      return null;
    };

    // plukk felter fra et leg-objekt (flere varianter)
    const legOrigin = (leg) =>
      pick(leg, ["origin", "from", "origin_iata", "origin_code", "departure_airport", "airport_from"]);
    const legDest = (leg) =>
      pick(leg, ["destination", "to", "destination_iata", "destination_code", "arrival_airport", "airport_to"]);

    const legDep = (leg) =>
      pick(leg, [
        "local_departure_date_time",
        "departure_at",
        "local_departure",
        "departure_time",
        "depart_at",
        "departure_datetime",
        "time_departure",
      ]);
    const legArr = (leg) =>
      pick(leg, [
        "local_arrival_date_time",
        "arrival_at",
        "local_arrival",
        "arrival_time",
        "arrive_at",
        "arrival_datetime",
        "time_arrival",
      ]);

    const legDurationMins = (leg) => {
      const raw = pick(leg, ["duration", "duration_mins", "duration_minutes", "travel_time", "flight_time"]);
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return n > 10000 ? Math.round(n / 60) : n; // sek -> min hvis det ser stort ut
    };

    // ---- robust object helper ----
    const pickObj = (v, keys) => {
      if (!v) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object") {
        for (const k of keys) {
          const x = v?.[k];
          if (x != null && x !== "") return x;
        }
      }
      return null;
    };

    // ---- robust airline + flight number ----
    const legAirline = (leg) => {
      const direct = pick(leg, [
        "airline",
        "carrier",
        "marketing_carrier",
        "operating_carrier",
        "airline_code",
        "carrier_code",
        "airline_iata",
      ]);
      if (direct && typeof direct === "string") return toUpper(direct);

      const obj =
        leg?.airline ||
        leg?.carrier ||
        leg?.marketing_carrier ||
        leg?.operating_carrier ||
        null;

      const code = pickObj(obj, ["iata", "iata_code", "code", "id", "carrier_code", "airline_code"]);
      return toUpper(code || "");
    };

    const legFlightNo = (leg) => {
      const direct = pick(leg, ["flight_number", "flight_no", "flightNumber", "flight_num", "number"]);
      if (direct != null && direct !== "") return toUpper(String(direct));

      const obj = leg?.flight || leg?.flight_number_obj || null;
      const n = pickObj(obj, ["number", "flight_number", "flightNo", "no"]);
      if (n != null && n !== "") return toUpper(String(n));

      return "";
    };

    // ---------------- build offers PER proposal ----------------
    const offers = [];
    let counter = 0;

    for (const t of tickets) {
      const proposals = Array.isArray(t?.proposals) ? t.proposals : [];
      const segs = Array.isArray(t?.segments) ? t.segments : [];
      const seg0 = segs[0] || null;

      const flightRefs = Array.isArray(seg0?.flights) ? seg0.flights : [];
      const legs = flightRefs.map(resolveLeg).filter(Boolean);

      const firstLeg = legs[0] || null;
      const lastLeg = legs[legs.length - 1] || null;

      const origin =
        (firstLeg && legOrigin(firstLeg)) ||
        pick(t, ["origin", "from", "origin_iata", "origin_code"]) ||
        "";

      const destination =
        (lastLeg && legDest(lastLeg)) ||
        pick(t, ["destination", "to", "destination_iata", "destination_code"]) ||
        "";

      const dep =
        (firstLeg && legDep(firstLeg)) ||
        pick(t, ["local_departure_date_time", "departure_at", "local_departure", "departure_time"]) ||
        null;

      const arr =
        (lastLeg && legArr(lastLeg)) ||
        pick(t, ["local_arrival_date_time", "arrival_at", "local_arrival", "arrival_time"]) ||
        null;

      const durationSum =
        legs.length > 0
          ? legs.reduce((acc, leg) => acc + (legDurationMins(leg) || 0), 0)
          : (num(t?.duration) ?? num(t?.total_duration) ?? num(t?.travel_time) ?? null);

      const depTime = fmtTimeHHMM(dep);
      const arrTime = fmtTimeHHMM(arr);
      const durationText = durationSum != null ? fmtDurationMins(durationSum) : "";
      const routeText = origin && destination ? `${toUpper(origin)} → ${toUpper(destination)}` : "";

      // stops: legs-1, ellers transfers
      const stops =
        legs.length > 0
          ? Math.max(0, legs.length - 1)
          : Array.isArray(seg0?.transfers)
          ? seg0.transfers.length
          : null;

      const stopsText = stops == null ? "" : stops === 0 ? "Direkte" : `${stops} stopp`;

      const airlinesText = legs.length ? uniq(legs.map(legAirline)).filter(Boolean).join(", ") : "";
      const flightNosText = legs.length ? uniq(legs.map(legFlightNo)).filter(Boolean).join(", ") : "";

      for (const p of proposals) {
        const offer_id = `${sid}:${counter}`;
        counter += 1;

        const tp_proposal_id =
          p?.id ?? p?.proposal_id ?? p?.uuid ?? p?.proposalId ?? p?.click_id ?? p?.clickId ?? null;

        const price = pickPriceFromProposal(p);
        const currency = pickCurrency(p, t);

        offers.push({
          offer_id,
          tp_proposal_id: tp_proposal_id != null ? String(tp_proposal_id) : null,

          price: typeof price === "number" ? price : null,
          currency,

          depTime,
          arrTime,
          durationText,

          routeText,
          stopsText,

          airlinesText,
          flightNosText,
          agentText: "",

          signature: t?.signature || null,
        });
      }
    }

    offers.sort((a, b) => (a.price ?? 1e18) - (b.price ?? 1e18));

    console.log("✅ TP counts:", {
      tickets: tickets.length,
      flight_legs: legsArr.length,
      offers: offers.length,
      is_over: isOver,
      tpRawTs: data?.last_update_timestamp,
      tsIn,
      tsOut: tpTs,
    });

    // --- DEBUG: bekreft resolveLeg + airline/flight_no ---
    if (tickets[0]) {
      const s0 = Array.isArray(tickets[0]?.segments) ? tickets[0].segments[0] : null;
      const firstRef = Array.isArray(s0?.flights) ? s0.flights[0] : null;
      const leg0 = resolveLeg(firstRef);
      console.log("🧪 seg0.flights[0]:", firstRef);
      console.log("🧪 resolveLeg(first) keys:", Object.keys(leg0 || {}));
      console.log("🧪 resolveLeg(first) airline/flight:", {
        airline: legAirline(leg0 || {}),
        flightNo: legFlightNo(leg0 || {}),
      });
    }

    if (offers[0]) {
      console.log("🧪 offer[0] mini:", {
        offer_id: offers[0].offer_id,
        tp_proposal_id: offers[0].tp_proposal_id,
        price: offers[0].price,
        currency: offers[0].currency,
        depTime: offers[0].depTime,
        arrTime: offers[0].arrTime,
        routeText: offers[0].routeText,
        airlinesText: offers[0].airlinesText,
        flightNosText: offers[0].flightNosText,
        stopsText: offers[0].stopsText,
      });
    }

    // cache mapping offer_id -> tp_proposal_id (til click fallback)
    const map = {};
    for (const o of offers) if (o.offer_id && o.tp_proposal_id) map[o.offer_id] = o.tp_proposal_id;
    flightSearchCache.set(sid, { ...cached, offer_to_tp_proposal: map });

    return res.json({
      ok: true,
      is_over: isOver,
      last_update_timestamp: tpTs,
      offers,
    });
  } catch (e) {
    console.error("❌ /api/flights/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream results failed",
      details: e?.response?.data || null,
    });
  }
});

// ==============================
// ✅ /api/flights/click (NY - RIKTIG)
// - bruker NYTT TP-click-endpoint:
//   https://[results_url]/searches/[search_id]/clicks/[proposal_id]
// - marker i header (påkrevd)
// - foretrekker tp_proposal_id fra appen
// - fallback: resolve proposal via offer_id "sid:n" ved å hente full results(ts=0)
// ==============================
app.post("/api/flights/click", async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res.status(500).json({
        error:
          "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_TOKEN / TRAVELPAYOUTS_MARKER mangler)",
      });
    }
    if (!tp?.realHost) {
      return res.status(500).json({
        error: "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_REAL_HOST mangler)",
      });
    }

    const { search_id, offer_id, proposal_id, tp_proposal_id } = req.body || {};
    const sid = String(search_id || "").trim();

    const clientOfferId = String(offer_id || proposal_id || "").trim();
    const clientTpProposalId = tp_proposal_id != null ? String(tp_proposal_id).trim() : "";

    console.log("➡️ /api/flights/click called", { sid, clientOfferId, clientTpProposalId });

    if (!sid) return res.status(400).json({ error: "Mangler search_id" });
    if (!clientTpProposalId && !clientOfferId) {
      return res.status(400).json({ error: "Mangler tp_proposal_id eller offer_id/proposal_id" });
    }

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt)." });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({
        error: "Cached results_url er ugyldig",
        details: { cached_results_url: cached.results_url },
      });
    }

    const pickUrlFromObj = (o) =>
      (o &&
        (o.url ||
          o.click_url ||
          o.clickUrl ||
          o.redirect_url ||
          o.redirectUrl ||
          o.deeplink ||
          o.deep_link ||
          o.deepLink ||
          o.link ||
          o.result_url ||
          o.resultUrl)) ||
      null;

    // ---- call NEW click endpoint ----
    async function doTpClickNewEndpoint(tpProposalId, sourceLabel) {
      const clickUrl = new URL(`/searches/${encodeURIComponent(sid)}/clicks/${encodeURIComponent(String(tpProposalId))}`, base).toString();

      // marker i header (påkrevd)
      const headers = {
        ...(makeHeaders?.(req, "", tp) || {}),
        "X-Affiliate-Marker": tp.marker,
        "X-Marker": tp.marker,
        marker: tp.marker,
      };

      console.log(`🖱️ TP click NEW (${sourceLabel}):`, { clickUrl, sid, proposal_id: String(tpProposalId) });

      const cr = await axios.get(clickUrl, {
        headers,
        timeout: 20000,
        validateStatus: (status) => status >= 200 && status < 400,
        maxRedirects: 0,
      });

      const url = pickUrlFromObj(cr?.data);

      if (!url) {
        console.log("🧪 TP click NEW status:", cr.status);
        console.log("🧪 TP click NEW headers:", cr.headers || {});
        console.log("🧪 TP click NEW data:", JSON.stringify(cr.data || {}, null, 2));

        return {
          ok: false,
          status: 502,
          error: "TP click manglet url (uventet respons)",
          details: { status: cr.status, headers: cr.headers || null, data: cr.data || null },
        };
      }

      return { ok: true, url, source: sourceLabel, tp_click: cr.data || null };
    }

    // ---- 1) direkte tp_proposal_id (best) ----
    if (clientTpProposalId) {
      const r = await doTpClickNewEndpoint(clientTpProposalId, "tp_click_direct");
      if (!r.ok) return res.status(r.status || 502).json({ error: r.error, details: r.details || null });
      return res.json({ ok: true, url: r.url, source: r.source });
    }

    // ---- 2) fallback: offer_id -> finn n'te proposal i samme rekkefølge ----
    async function fetchFullResults() {
      const resultsUrl = new URL("/search/affiliate/results", base).toString();
      const payload = { marker: tp.marker, search_id: sid, last_update_timestamp: 0 };
      const signature = makeSignature(tp.token, tp.marker, payload);

      const rr = await axios.post(
        resultsUrl,
        { ...payload, signature },
        {
          headers: makeHeaders(req, signature, tp),
          timeout: 20000,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
        }
      );

      if (rr.status === 304) {
        return {
          ok: false,
          status: 409,
          error: "TP returnerte 304 på click-fetch og vi har ingen cached body. Start søket på nytt.",
        };
      }

      return { ok: true, data: rr.data || {} };
    }

    const m = clientOfferId.match(/^(.+):(\d+)$/);
    if (!m || m[1] !== sid) {
      return res.status(400).json({
        error: "Ugyldig offer_id format (forventet sid:n)",
        details: { sid, clientOfferId },
      });
    }

    const wantedCounter = Number(m[2]);
    if (!Number.isInteger(wantedCounter) || wantedCounter < 0) {
      return res.status(400).json({ error: "Ugyldig offer_id counter", details: { clientOfferId } });
    }

    // hvis vi har cached mapping, bruk den først
    const cachedProposal = cached?.offer_to_tp_proposal?.[clientOfferId];
    if (cachedProposal) {
      const r = await doTpClickNewEndpoint(cachedProposal, "tp_click_cached_map");
      if (!r.ok) return res.status(r.status || 502).json({ error: r.error, details: r.details || null });
      return res.json({ ok: true, url: r.url, source: r.source });
    }

    const full = await fetchFullResults();
    if (!full.ok) return res.status(full.status || 502).json({ error: full.error, details: full.details || null });

    const tickets = Array.isArray(full.data?.tickets) ? full.data.tickets : [];

    let counter = 0;
    let foundProposal = null;

    for (const t of tickets) {
      const proposals = Array.isArray(t?.proposals) ? t.proposals : [];
      for (const p of proposals) {
        if (counter === wantedCounter) {
          foundProposal = p;
          break;
        }
        counter += 1;
      }
      if (foundProposal) break;
    }

    if (!foundProposal) {
      return res.status(404).json({
        error: "Fant ikke proposal for offer_id",
        details: { clientOfferId, wantedCounter, proposalsScanned: counter },
      });
    }

    const tpProposalId =
      foundProposal?.id ??
      foundProposal?.proposal_id ??
      foundProposal?.uuid ??
      foundProposal?.proposalId ??
      foundProposal?.click_id ??
      foundProposal?.clickId ??
      null;

    if (!tpProposalId) {
      return res.status(409).json({
        error: "Mangler TP proposal_id på valgt proposal",
        details: { proposalKeys: Object.keys(foundProposal || {}) },
      });
    }

    const clicked = await doTpClickNewEndpoint(tpProposalId, "tp_click_fallback");
    if (!clicked.ok) return res.status(clicked.status || 502).json({ error: clicked.error, details: clicked.details || null });

    return res.json({ ok: true, url: clicked.url, source: clicked.source });
  } catch (e) {
    console.error("❌ /api/flights/click feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({ error: "Upstream click failed", details: e?.response?.data || null });
  }
});

// -------------------------
// LOCATIONS – /api/locations/suggest?q=oslo
// -------------------------
app.get("/api/locations/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ locations: [] });

    const r = await axios.get(
      "https://autocomplete.travelpayouts.com/places2",
      {
        params: {
          term: q,
          locale: "no",
          "types[]": ["city", "airport"],
        },
        timeout: 10000,
      }
    );

    const locations = (Array.isArray(r.data) ? r.data : [])
      .slice(0, 10)
      .map((p) => ({
        id: p.code, // IATA
        code: p.code || null,
        name: p.name || p.city_name || p.country_name || p.code,
        city: p.city_name || null,
        country: p.country_name || null,
        type: p.type || null, // city/airport
        subdivision: null,
      }));

    return res.json({ locations });
  } catch (e) {
    console.error(
      "❌ TP autocomplete error:",
      e?.response?.data || e?.message || e
    );
    return res.status(502).json({ error: "Upstream autocomplete failed" });
  }
});

const HOTEL_CREATE_URL =
  "https://api.travelpayouts.com/hotellook_search/v1/create_search";

function toQuery(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    p.set(k, String(v));
  }
  return p;
}

function withChildAges(params, childAges = []) {
  const out = { ...params };
  const ages = Array.isArray(childAges) ? childAges : [];
  ages.forEach((age, idx) => {
    out[`childAge${idx + 1}`] = Number(age) || 1;
  });
  return out;
}

app.post("/api/hotels/start", async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res.status(500).json({ error: "Mangler TRAVELPAYOUTS_TOKEN/TRAVELPAYOUTS_MARKER" });
    }

    const body = req.body || {};
    const iata = String(body.iata || "").trim().toUpperCase();
    const checkIn = String(body.checkIn || "").trim();   // YYYY-MM-DD
    const checkOut = String(body.checkOut || "").trim(); // YYYY-MM-DD

    if (!iata || !checkIn || !checkOut) {
      return res.status(400).json({ error: "Mangler iata/checkIn/checkOut" });
    }

    const adultsCount = Number(body.adultsCount ?? 2);
    const childrenCount = Number(body.childrenCount ?? 0);
    const childAges = Array.isArray(body.childAges) ? body.childAges : [];

    const baseParams = {
      iata,
      checkIn,
      checkOut,
      adultsCount,
      childrenCount,
      customerIP: normalizeIp(getUserIp(req)),
      lang: body.lang || "no_NO",
      currency: body.currency || "NOK",
      waitForResult: body.waitForResult ? 1 : 0,
      marker: tp.marker,
    };

    const params = withChildAges(baseParams, childAges);

    const signature = makeSignature(tp.token, tp.marker, params);
    params.signature = signature;

    const url = `${HOTEL_CREATE_URL}?${toQuery(params).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });

    const searchId =
      r.data?.searchId ||
      r.data?.search_id ||
      r.data?.data?.searchId ||
      r.data?.data?.search_id ||
      null;

    if (!searchId) {
      return res.status(502).json({ error: "Ugyldig svar fra create_search", details: r.data || null });
    }

    return res.json({ ok: true, searchId: String(searchId) });
  } catch (e) {
    console.error("❌ /api/hotels/start feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({ error: "Upstream hotels start failed", details: e?.response?.data || null });
  }
});

const HOTEL_RESULT_URL =
  "https://api.travelpayouts.com/hotellook_search/v1/result";

app.post("/api/hotels/results", async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res.status(500).json({ error: "Mangler TRAVELPAYOUTS_TOKEN/TRAVELPAYOUTS_MARKER" });
    }

    const body = req.body || {};
    const searchId = String(body.searchId || "").trim();
    if (!searchId) return res.status(400).json({ error: "Mangler searchId" });

    const params = {
      searchId,
      limit: Number(body.limit ?? 50),
      offset: Number(body.offset ?? 0),
      sortBy: body.sortBy || "popularity",
      sortAsc: body.sortAsc === 0 ? 0 : 1,
      marker: tp.marker,
    };

    const signature = makeSignature(tp.token, tp.marker, params);
    params.signature = signature;

    const url = `${HOTEL_RESULT_URL}?${toQuery(params).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });
    return res.json({ ok: true, ...r.data });
  } catch (e) {
    console.error("❌ /api/hotels/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({ error: "Upstream hotels results failed", details: e?.response?.data || null });
  }
});

// ---------- Travelpayouts Experiences (start/results) ----------

const EXPERIENCE_CREATE_URL =
  "https://api.travelpayouts.com/experience_search/v1/create_search"; // TODO: sjekk riktig endpoint i din TP-avtale

const EXPERIENCE_RESULT_URL =
  "https://api.travelpayouts.com/experience_search/v1/result"; // TODO: sjekk riktig endpoint i din TP-avtale

app.post("/api/experiences/start", authMiddleware, requirePro, async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res
        .status(500)
        .json({ error: "Mangler TRAVELPAYOUTS_TOKEN/TRAVELPAYOUTS_MARKER" });
    }

    const body = req.body || {};
    const query = String(body.query || "").trim(); // f.eks. "Eiffel Tower tickets"
    const lang = String(body.lang || "no_NO");
    const currency = String(body.currency || "NOK");

    if (!query) return res.status(400).json({ error: "Mangler query" });

    const params = {
      query,
      customerIP: normalizeIp(getUserIp(req)),
      lang,
      currency,
      waitForResult: body.waitForResult ? 1 : 0,
      marker: tp.marker,
    };

    const signature = makeSignature(tp.token, tp.marker, params);
    params.signature = signature;

    const url = `${EXPERIENCE_CREATE_URL}?${toQuery(params).toString()}`;
    const r = await axios.get(url, { timeout: 20000 });

    const searchId =
      r.data?.searchId ||
      r.data?.search_id ||
      r.data?.data?.searchId ||
      r.data?.data?.search_id ||
      null;

    if (!searchId) {
      return res.status(502).json({
        error: "Ugyldig svar fra create_search (experiences)",
        details: r.data || null,
      });
    }

    return res.json({ ok: true, searchId: String(searchId) });
  } catch (e) {
    console.error("❌ /api/experiences/start feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream experiences start failed",
      details: e?.response?.data || null,
    });
  }
});

app.post("/api/experiences/results", authMiddleware, requirePro, async (req, res) => {
  try {
    if (!tp?.token || !tp?.marker) {
      return res
        .status(500)
        .json({ error: "Mangler TRAVELPAYOUTS_TOKEN/TRAVELPAYOUTS_MARKER" });
    }

    const body = req.body || {};
    const searchId = String(body.searchId || "").trim();
    if (!searchId) return res.status(400).json({ error: "Mangler searchId" });

    const params = {
      searchId,
      limit: Number(body.limit ?? 50),
      offset: Number(body.offset ?? 0),
      sortBy: body.sortBy || "popularity",
      sortAsc: body.sortAsc === 0 ? 0 : 1,
      marker: tp.marker,
    };

    const signature = makeSignature(tp.token, tp.marker, params);
    params.signature = signature;

    const url = `${EXPERIENCE_RESULT_URL}?${toQuery(params).toString()}`;
    const r = await axios.get(url, { timeout: 20000 });

    return res.json({ ok: true, ...r.data });
  } catch (e) {
    console.error("❌ /api/experiences/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream experiences results failed",
      details: e?.response?.data || null,
    });
  }
});

// ---------------- Car rentals helpers ----------------

function toArrayMaybe(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
}

function pickStop1(stops) {
  const s = Array.isArray(stops) ? stops : [];
  const s1 = s[0];
  return s1 && typeof s1 === "object" ? s1 : null;
}

function toNum(v) {
  const n = typeof v === "number" ? v : Number(String(v || "").trim());
  return Number.isFinite(n) ? n : null;
}

function pickLatLngFromStop(stop) {
  if (!stop) return null;

  // støtter flere mulige strukturer
  const lat =
    toNum(stop.lat) ??
    toNum(stop.latitude) ??
    toNum(stop?.coords?.lat) ??
    toNum(stop?.coords?.latitude) ??
    toNum(stop?.location?.lat) ??
    toNum(stop?.location?.latitude);

  const lng =
    toNum(stop.lng) ??
    toNum(stop.lon) ??
    toNum(stop.longitude) ??
    toNum(stop?.coords?.lng) ??
    toNum(stop?.coords?.lon) ??
    toNum(stop?.coords?.longitude) ??
    toNum(stop?.location?.lng) ??
    toNum(stop?.location?.lon) ??
    toNum(stop?.location?.longitude);

  if (typeof lat === "number" && typeof lng === "number") return { lat, lng };
  return null;
}

function pickTextFromStop(stop) {
  if (!stop) return null;
  const name =
    stop.name ||
    stop.title ||
    stop.place ||
    stop.city ||
    stop.location ||
    stop.destination ||
    stop.address ||
    null;

  const country = stop.country || stop.countryName || null;
  const parts = [name, country].filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// Foreløpig: generer en stabil fallback-lenke.
// Senere: erstatt med affiliate-lenke / partner deep-link.
function makeCarRentalUrl({ queryText, pickupISO, dropoffISO }) {
  const q = encodeURIComponent(
    [
      "bilutleie",
      queryText || "",
      pickupISO ? `pickup ${pickupISO}` : "",
      dropoffISO ? `dropoff ${dropoffISO}` : "",
    ]
      .filter(Boolean)
      .join(" ")
  );
  return `https://www.google.com/search?q=${q}`;
}

// Foreløpig: “search” returnerer bare ett “tilbud” pr kategori.
// Senere: bytt ut med ekte aggregator som returnerer mange tilbud.
function searchCarRentals({ queryText, pickupISO, dropoffISO }) {
  const url = makeCarRentalUrl({ queryText, pickupISO, dropoffISO });

  // Eksempeldata som UI kan vise (teaser/full)
  return [
    {
      id: "google-search",
      provider: "Søk",
      title: "Finn bilutleie (søk)",
      location: queryText || null,
      price_hint: null,
      url,
    },
  ];
}

// GET: hent bilutleie-forslag knyttet til turens stopp 1 + datoer fra klient
app.get("/api/trips/:id/car-rentals", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const ent = await getUserEntitlements(req.user.id);
    const isPro = !!ent?.isPro;

    const tripRes = await query(
      `
      SELECT id, user_id, source_episode_id, source_type, stops, created_at
      FROM trips
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let stops = toArrayMaybe(row.stops);

    // canonical override hvis dette er en "brukertur" fra episode
    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT stops
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) {
        const canonStops = toArrayMaybe(canonRes.rows[0].stops);
        if (canonStops.length) stops = canonStops;
      }
    }

    const stop1 = pickStop1(stops);
    const queryText = pickTextFromStop(stop1);
    const latlng = pickLatLngFromStop(stop1);

    // Datoer kommer fra klient (må legges inn av bruker)
    // ISO 8601, f.eks: 2026-01-18T10:00
    const pickup = typeof req.query.pickup === "string" ? req.query.pickup.trim() : "";
    const dropoff = typeof req.query.dropoff === "string" ? req.query.dropoff.trim() : "";

    // Vi krever ikke pickup/dropoff for å returnere liste (kan vise “fyll inn datoer” i UI),
    // men for et reelt søk vil du bruke disse.
    const all = searchCarRentals({
      queryText: queryText || (latlng ? `${latlng.lat},${latlng.lng}` : ""),
      pickupISO: pickup || null,
      dropoffISO: dropoff || null,
    });

    const full = (all || []).filter((x) => x && typeof x === "object");
    const preview = full.slice(0, 3).map((x) => ({
      id: x.id || null,
      title: x.title || "Bilutleie",
      provider: x.provider || null,
      location: x.location || null,
    }));

    return res.json({
      ok: true,
      tripId,
      destination_text: queryText || null,
      destination_latlng: latlng || null,
      pickup: pickup || null,
      dropoff: dropoff || null,
      car_rentals: isPro ? full : preview,
      entitlements: { isPro, locked: { car_rentals: !isPro } },
      counts: { car_rentals: full.length },
    });
  } catch (e) {
    console.error("/api/trips/:id/car-rentals-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente bilutleie." });
  }
});

// backend: rute for å hente destinasjon (stopp 1) + evt. providers
app.get("/api/trips/:id/bike-rentals", authMiddleware, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await query(
      `SELECT id, user_id, source_episode_id, source_type, stops
       FROM trips
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];

    // canonical stops for episode-trips (hvis du ønsker det)
    let stops = parseJsonArray(row.stops);
    if (row.source_episode_id) {
      const canonRes = await query(
        `
        SELECT stops
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.source_episode_id]
      );
      if (canonRes.rows?.[0]) stops = parseJsonArray(canonRes.rows[0].stops);
    }

    const stop1 = Array.isArray(stops) && stops.length ? stops[0] : null;

    // Normaliser litt (ikke anta feltnavn – bruk det du har i stops)
    const destination = stop1
      ? {
          name: stop1.name || stop1.title || stop1.place || null,
          city: stop1.city || stop1.locality || null,
          country_code: stop1.country_code || stop1.countryCode || stop1.country || null,
          lat: stop1.lat ?? null,
          lng: stop1.lng ?? null,
          raw: stop1,
        }
      : null;

    // Hvis du har en egen providers-liste/affiliate kan du returnere her.
    // Foreløpig tom, screenen har alltid "Søk i området".
    return res.json({ ok: true, tripId, destination, providers: [] });
  } catch (e) {
    console.error("/api/trips/:id/bike-rentals feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente sykkelutleie-destinasjon." });
  }
});

// -------------------------------------------------------
//  GLOBAL FEILHANDLER (helt nederst)
// -------------------------------------------------------
app.use((err, req, res, next) => {
  if (!err) return next();

  // 1) Multer-feil -> 400
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  // 2) Våre "user input" feil (du bruker bl.a. "tillatt"-teksten)
  const msg = String(err.message || "");
  if (msg.includes("Kun JPG, PNG og WEBP er tillatt") || msg.includes("tillatt")) {
    return res.status(400).json({ error: msg });
  }

  // 3) Default -> 500
  console.error("❌ Unhandled error:", err);
  return res.status(500).json({ error: "Uventet serverfeil." });
});

// -------------------------------------------------------
//  SERVER START
// -------------------------------------------------------

if (process.env.NODE_ENV === "production") {
  assertEnvOrThrow();
}

app.listen(PORT, () => {
  console.log(`🚀 Grenseløs Reise backend kjører på port ${PORT}`);
});
