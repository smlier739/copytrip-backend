// backend/index.js – Grenseløs Reise backend

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pkg from "pg";
import OpenAI from "openai";
import axios from "axios";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config({ override: true });

// ESM-vennlig __dirname / __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM;

// Init Resend
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Debug API-nøkkel (kun prefix)
console.log(
  "DEBUG OPENAI_API_KEY prefix:",
  (process.env.OPENAI_API_KEY || "").slice(0, 12) || "IKKE SATT"
);

const { Pool } = pkg;

const PORT = process.env.PORT || 4000;

// -------------------------------------------------------
//  APP + DATABASE + OPENAI
// -------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Filopplasting for galleri / virtuell reise ----------

const uploadDir = "/var/data/uploads";

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

function normalizeTripStructure(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      title: "Reiseforslag fra KI",
      description: null,
      stops: [],
      packing_list: [],
      hotels: []
    };
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : "Reiseforslag fra KI";

  const description =
    typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : null;

  // ---- STOPS ----
  const rawStops = Array.isArray(parsed.stops) ? parsed.stops : [];
  const stops = rawStops.map((s, idx) => {
    const name =
      (s && (s.name || s.title)) ||
      `Stopp ${idx + 1}`;

    const desc =
      s && typeof s.description === "string"
        ? s.description
        : "";

    let lat = s && (s.lat ?? s.latitude ?? null);
    let lng = s && (s.lng ?? s.longitude ?? null);
    let day = s && (s.day ?? null);

    // Streng → tall (lat/lng)
    if (typeof lat === "string" && lat.trim() !== "") {
      const n = Number(lat.replace(",", "."));
      lat = isNaN(n) ? null : n;
    }
    if (typeof lng === "string" && lng.trim() !== "") {
      const n = Number(lng.replace(",", "."));
      lng = isNaN(n) ? null : n;
    }

    // Streng → tall (day)
    if (typeof day === "string" && day.trim() !== "") {
      const n = Number(day);
      day = isNaN(n) ? null : n;
    }
    if (day == null) {
      day = idx + 1;
    }

    return {
      name,
      description: desc,
      lat: typeof lat === "number" ? lat : null,
      lng: typeof lng === "number" ? lng : null,
      day
    };
  });

    // ---- PACKING LIST ----
    const rawPacking =
      parsed.packing_list ||
      parsed.packingList ||
      parsed.packing ||
      [];

    const contextText = `${parsed.title || ""}\n${parsed.description || ""}\n` +
      (Array.isArray(parsed.stops) ? parsed.stops.map(s => `${s?.name || ""} ${s?.description || ""}`).join("\n") : "");

    const packing_list = normalizePackingToFourCategoriesSmart(rawPacking, contextText);

      // ---- HOTELLER / OVERNATTING ----
  const rawHotels =
    parsed.hotels ||
    parsed.accommodations ||
    parsed.accommodation_suggestions ||
    [];

  const hotels = Array.isArray(rawHotels)
    ? rawHotels.map((h) => {
        const name =
          (h && (h.name || h.title)) ||
          "Hotell/overnatting";

        const location =
          (h && (h.location || h.city || h.area)) ||
          null;

        const description =
          h && typeof h.description === "string"
            ? h.description
            : null;

        let price = h && (h.price_per_night ?? h.approximate_price_per_night ?? null);
        if (typeof price === "string" && price.trim() !== "") {
          const n = Number(price.replace(",", "."));
          price = isNaN(n) ? null : n;
        }

        const url =
          (h && (h.url || h.link || h.booking_url)) ||
          null;

        return {
          name,
          location,
          description,
          price_per_night: typeof price === "number" ? price : null,
          url
        };
      })
    : [];

  return { title, description, stops, packing_list, hotels };
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

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");

  if (!token) {
    return res.status(401).json({ error: "Manglende Authorization header." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Hent bruker fra DB slik at vi alltid har is_admin + navn tilgjengelig
    const u = await query(
      `SELECT id, email, full_name, is_admin FROM users WHERE id=$1`,
      [decoded.userId]
    );

    if (u.rowCount === 0) {
      return res.status(401).json({ error: "Bruker ikke funnet." });
    }

    const user = u.rows[0];
    req.user = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      is_admin: !!user.is_admin
    };

    next();
  } catch (err) {
    console.warn("JWT-feil:", err.message);
    res.status(401).json({ error: "Ugyldig eller utløpt token." });
  }
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

async function getSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error("SPOTIFY_CLIENT_ID eller SPOTIFY_CLIENT_SECRET mangler");
  }

  const tokenRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.SPOTIFY_CLIENT_ID +
              ":" +
              process.env.SPOTIFY_CLIENT_SECRET
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return tokenRes.data.access_token;
}

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

  // En enkel “pris”-heuristikk (du kan justere)
  const defaultHotelPrice = budgetPerDay
    ? Math.max(500, Math.round(budgetPerDay * 0.7))
    : 1200;

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
        ]
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
    max_output_tokens: 1600 // litt mer rom => mindre “drop” av hotels
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
      trip: { title: "Reiseforslag", description: null, stops: [], packing_list: [] }
    };
  }

  // Defensiv normalisering
  if (!parsed.trip || typeof parsed.trip !== "object") parsed.trip = {};
  if (!Array.isArray(parsed.trip.stops)) parsed.trip.stops = [];
  if (!Array.isArray(parsed.trip.packing_list)) parsed.trip.packing_list = [];

  // ✅ Sikre hotels per stop + fallback hvis tomt
  parsed.trip.stops = parsed.trip.stops.map((stop, idx) => {
    const s = stop && typeof stop === "object" ? stop : {};
    let hotels = Array.isArray(s.hotels) ? s.hotels : [];

    // Rens hotellobjekter
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
      .filter((h) => h.name); // må ha navn

    // Hvis modellen fortsatt ga 0 hoteller -> legg inn fallback-forslag
    if (hotels.length === 0) {
      const place = (typeof s.name === "string" && s.name.trim()) ? s.name.trim() : `Stopp ${idx + 1}`;
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

    return { ...s, hotels };
  });

  return parsed;
}

// -------------------------------------------------------
//  KI: EPISODE-BASERT TRIP (PERSONLIG + TILPASNING)
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

  const systemPrompt = `
Du er en erfaren reiseplanlegger som lager konkrete reiseforslag basert på
Grenseløs-episoder OG brukerens ønsker.

Du MÅ ALLTID svare med gyldig JSON, uten forklaringstekst rundt.

Returner strukturert JSON med “title”, “description”, “stops”, “packing_list”, “hotels” og “experiences”.
“experiences” er en array av opplevelser som ofte krever billett/booking, med feltene: title, location, description, og helst booking_url.

Output-format:

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
      "items": [ "Vind- og regnjakke", "Gode joggesko" ]
    },
    {
      "category": "Toalettsaker",
      "items": [ "Tannbørste og tannkrem", "Solkrem" ]
    },
    {
      "category": "Elektronikk",
      "items": [ "Mobil og lader", "Powerbank" ]
    },
    {
      "category": "Annet",
      "items": [ "Pass/ID-kort", "Reiseforsikringsbevis" ]
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

KRAV FOR PACKING_LIST:
- "packing_list" SKAL ALLTID være en liste med NØYAKTIG 4 elementer.
- De 4 elementene SKAL ha "category" lik:
    1) "Klær"
    2) "Toalettsaker"
    3) "Elektronikk"
    4) "Annet"
- Kategorinavnene må være akkurat disse.
- Hver kategori SKAL ha en "items"-liste med 3–10 KONKRETE ting.
- Ikke skriv generelle ting som "annet", "diverse", "osv." som item.

KRAV FOR STOPS:
- 3–10 stopp.
- Hvert stopp SKAL ha "day", "name" og "description".
- Hvis du ikke vet koordinater, sett "lat" og "lng" til null.

KRAV FOR HOTELS:
- 2–6 forslag totalt.
- Hvert hotell SKAL ha "name".
- "price_per_night" skal være et tall (omtrentlig pris per natt) i NOK hvis naturlig, ellers null.
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
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7
  });

  const aiText =
    completion.choices?.[0]?.message?.content?.trim() || "";

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
      hotels: []
    };
  }

  return { trip, raw: aiText };
}

// -------------------------------------------------------
//  AUTO-GENERERE TRIPS FOR EPISODER (BRUKT I SYNC)
// -------------------------------------------------------

async function ensureTripForEpisode(episode, userId) {
  // 1) Finn eksisterende *system-trip* for denne episoden for denne brukeren
  //    Vi skiller den tydelig fra vanlige brukerreiser via source_type = 'grenselos_episode'
  const existing = await query(
    `
      SELECT id, stops, packing_list, hotels, gallery, source_type, created_at
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

  // 2) Ingen system-trip ennå: lag en ny med KI-innhold som «mal»,
  //    men galleri er TOMT inntil Admin laster opp.
  const ai = await generateTripFromAI({
    sourceUrl: episode.external_url,
    userDescription: `Lag en reise basert på Grenseløs-episoden: ${episode.name}`,
    userProfile: null
  });

  const trip = ai.trip || {};
  const stops = Array.isArray(trip.stops) ? trip.stops : [];
  const packingList = Array.isArray(trip.packing_list)
    ? trip.packing_list
    : [];

  // 🔁 FLATT UT hoteller fra hvert stopp til et felles hotels-array
  const hotels = [];
  for (const s of stops) {
    if (!s || typeof s !== "object") continue;
    if (!Array.isArray(s.hotels)) continue;

    for (const h of s.hotels) {
      if (!h || typeof h !== "object") continue;

      let price = h.approx_price_per_night ?? h.price_per_night ?? null;
      if (typeof price === "string" && price.trim() !== "") {
        const n = Number(price.replace(",", "."));
        price = isNaN(n) ? null : n;
      }

      hotels.push({
        name: h.name || h.title || "Hotell/overnatting",
        location: s.name || null,
        description: h.notes || h.description || null,
        price_per_night: typeof price === "number" ? price : null,
        url: h.url || h.booking_url || null
      });
    }
  }

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
        episode_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,'grenselos_episode',$7,$8,$9)
      RETURNING id
    `,
    [
      userId,
      trip.title || episode.name,
      trip.description || episode.description,
      JSON.stringify(stops),
      JSON.stringify(packingList),
      JSON.stringify(hotels),
      episode.id,
      JSON.stringify([]),   // galleri fylles KUN via admin-endepunktene
      episode.external_url || null
    ]
  );

  console.log(
    "[ensureTripForEpisode] Opprettet NY system-trip for episode",
    episode.id,
    "trip_id =",
    insert.rows[0].id
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
  '/api/trips/:id/travel-advice',
  authMiddleware,
  async (req, res) => {
    try {
      const tripId = req.params.id;

      // Hent reise – bare kolonner du vet finnes
      const tripRes = await query(
        `
        SELECT id, title, description, stops
        FROM trips
        WHERE id = $1 AND user_id = $2
        `,
        [tripId, req.user.id]
      );

      if (tripRes.rows.length === 0) {
        return res.status(404).json({ error: 'Fant ikke denne reisen.' });
      }

      const trip = tripRes.rows[0];

      const country = await inferCountryForTrip(trip);  // 👈 viktig: await
      const advice = await buildTravelAdviceText(country);

      console.log('DEBUG travel-advice:', { tripId, country, adviceSnippet: advice.slice(0, 120) });
      console.log(
        'DEBUG travel-advice country for trip',
        tripId,
        '=>',
        country
      );
        
      res.json({
        tripId,
        country: country || null,
        advice
      });
    } catch (e) {
      console.error('/api/trips/:id/travel-advice-feil:', e);
      res.status(500).json({
        error: 'Kunne ikke hente reiseråd.'
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

import crypto from "crypto";

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
    const resetUrl = `https://www.podtech.no/endre-passord-i-grenselos-reise-appen/?token=${encodeURIComponent(resetToken)}`;
      
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


// ----------------------------------------------------------------------
// 📌 API: Hent alle brukerens reiser
//   - canonical galleri/hoteller/pakkeliste fra system-trips for episoder
//   - generisk galleri for "fra scratch"
//   - klikkbare hoteller + opplevelser (experiences)
// ----------------------------------------------------------------------
app.get("/api/trips", authMiddleware, async (req, res) => {
  try {
    // 1) Hent brukerens trips
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

    // 2) Finn episodeIds det pekes på
    const episodeIds = [
      ...new Set(
        rows
          .map((r) => r.source_episode_id)
          .filter((id) => typeof id === "string" && id.trim() !== "")
      )
    ];

    // --- helpers ---
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
      // postgres jsonb kan komme som objekt/array avhengig av driver; vi støtter kun array her
      return [];
    };

    const isHttpUrl = (s) => {
      if (typeof s !== "string") return false;
      const t = s.trim();
      return /^https?:\/\/\S+/i.test(t);
    };

    // 🏨 Hotell-url normalisering
    const makeHotelUrl = (h) => {
      const raw =
        (typeof h.url === "string" && h.url.trim()) ||
        (typeof h.booking_url === "string" && h.booking_url.trim()) ||
        (typeof h.link === "string" && h.link.trim()) ||
        (typeof h.external_url === "string" && h.external_url.trim()) ||
        null;

      if (raw) return isHttpUrl(raw) ? raw.trim() : null;

      const name = (h.name || h.title || "").toString().trim();
      const location = (h.location || h.city || h.area || "").toString().trim();
      if (!name) return null;

      const q = encodeURIComponent(location ? `${name} ${location}` : name);
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
    };

    // 🎟️ Opplevelser-url normalisering
    const makeExperienceUrl = (x) => {
      const raw =
        (typeof x.url === "string" && x.url.trim()) ||
        (typeof x.booking_url === "string" && x.booking_url.trim()) ||
        (typeof x.link === "string" && x.link.trim()) ||
        (typeof x.external_url === "string" && x.external_url.trim()) ||
        null;

      if (raw) return isHttpUrl(raw) ? raw.trim() : null;

      const title = (x.title || x.name || "").toString().trim();
      const location = (x.location || x.city || x.area || "").toString().trim();
      if (!title) return null;

      const q = encodeURIComponent(location ? `${title} ${location}` : title);
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
    };

    let canonicalByEpisodeId = {};

    if (episodeIds.length > 0) {
      // 3) Hent canonical fra system-trips (nyeste per episode)
      const canonRes = await query(
        `
        SELECT
          source_episode_id,
          gallery,
          hotels,
          packing_list,
          created_at
        FROM trips
        WHERE source_type = 'grenselos_episode'
          AND source_episode_id = ANY($1)
        ORDER BY source_episode_id ASC, created_at DESC
        `,
        [episodeIds]
      );

      canonicalByEpisodeId = canonRes.rows.reduce((acc, row) => {
        const episodeId = row.source_episode_id;
        if (!episodeId) return acc;

        if (!acc[episodeId]) {
          acc[episodeId] = {
            gallery: parseJsonArray(row.gallery),
            hotels: parseJsonArray(row.hotels),
            packing_list: row.packing_list
          };
        }
        return acc;
      }, {});
    }

    // 4) Normaliser + canonical fallback
    const trips = rows.map((row) => {
      let stops = parseJsonArray(row.stops);
      let gallery = parseJsonArray(row.gallery);
      let hotels = parseJsonArray(row.hotels);
      let experiences = parseJsonArray(row.experiences);
      const packing = row.packing_list;

      const episodeId = row.source_episode_id;

      if (episodeId && canonicalByEpisodeId[episodeId]) {
        const canon = canonicalByEpisodeId[episodeId];
        gallery = parseJsonArray(canon.gallery);
        hotels = parseJsonArray(canon.hotels);
      } else {
        if (!Array.isArray(gallery) || gallery.length === 0) {
          gallery = getGenericVirtualTripGallery(3);
        }
      }

      // 🏨 hoteller klikkbare
      hotels = (hotels || [])
        .filter((h) => h && typeof h === "object")
        .map((h) => ({ ...h, url: makeHotelUrl(h) }));

      // 🎟️ opplevelser klikkbare
      experiences = (experiences || [])
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

      // pakkeliste normaliseres med din eksisterende helper
      const normalizedPacking = normalizePackingForClient(packing);

      return {
        ...row,
        stops,
        gallery,
        hotels,
        experiences,
        packing_list: normalizedPacking
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

app.post("/api/trips", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      description,
      stops,
      packing_list,
      hotels,
      gallery,                // 👈 Hentet fra klient hvis KI genererer galleri
      source_type,
      source_episode_id,      // 👈 ID fra Spotify-episoden
      episode_url             // optional
    } = req.body ?? {};

    if (!title || !Array.isArray(stops)) {
      return res.status(400).json({
        error: "Mangler title eller stops (array) i request body."
      });
    }

    const experiences = Array.isArray(req.body.experiences) ? req.body.experiences : [];
      
    // ---------------- Kvote-sjekk ----------------
    const { isPremium, isAdmin, tripCount, freeLimit } =
      await getUserTripStats(req.user.id);

    // Admin-brukere skal ikke stoppes av gratisgrense
    if (!isPremium && !isAdmin && tripCount >= freeLimit) {
      return res.status(402).json({
        error: "Gratisgrensen er nådd.",
        code: "FREE_LIMIT_REACHED",
        details: { tripCount, freeLimit }
      });
    }

    // ---------------- Normalisering ----------------
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

    let finalStops   = parseArrayField(stops);
    let finalPacking = parseArrayField(packing_list);
    let finalHotels  = parseArrayField(hotels);
    let finalGallery = parseArrayField(gallery);   // 👈 Hent galleri fra klienten hvis det finnes
    let sourceType   = null;

    // ---------------- Episode-baserte reiser ----------------
    if (source_episode_id) {
      sourceType = "user_episode_trip";

      const sysRes = await query(
        `
          SELECT packing_list, hotels, gallery
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

        // Pakkeliste
        if (finalPacking.length === 0) {
          finalPacking = parseArrayField(sys.packing_list);
        }

        // Hoteller
        if (finalHotels.length === 0) {
          finalHotels = parseArrayField(sys.hotels);
        }

        // GALLERI — alltid bruk systemets galleri for episode
        const g = parseArrayField(sys.gallery);
        if (g.length > 0) {
          finalGallery = g;
        }
      }

    } else {
      // ---------------- Vanlige KI / scratch-reiser ----------------
      sourceType = source_type || null;

      // Hvis KI har generert galleri → bruk det.
      if (finalGallery.length === 0) {
        // Ingen KI-galleri mottatt → lag et relevant galleri fra destinasjonen.
        // Krever at du har implementert generateGalleryForTrip().
        finalGallery = await generateGalleryForTrip(title, description, finalStops);
      }
    }

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
        req.user.id,
        title,
        description || null,
        JSON.stringify(finalStops),
        JSON.stringify(finalPacking),
        JSON.stringify(finalHotels),
        sourceType,
        source_episode_id || null,
        JSON.stringify(finalGallery),
        episode_url || null.
        JSON.stringify(experiences)
      ]
    );

    const row = insert.rows[0];

    res.status(201).json({
      trip: {
        ...row,
        stops: finalStops,
        packing_list: finalPacking,
        hotels: finalHotels,
        gallery: finalGallery
      }
    });

  } catch (e) {
    console.error("/api/trips POST-feil:", e);
    res.status(500).json({ error: "Kunne ikke opprette reise." });
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
//  VIPPS: OPPRETT BETALING (MVP-ENDPOINT)
// -------------------------------------------------------

// Disse legger du inn i .env etter hvert som du får dem fra Vipps
// VIPPS_CLIENT_ID=...
// VIPPS_CLIENT_SECRET=...
// VIPPS_MERCHANT_SERIAL=...
// VIPPS_SUBSCRIPTION_KEY=...
// VIPPS_BASE_URL=https://apitest.vipps.no   # testmiljø
// VIPPS_TEST_REDIRECT_URL=https://vipps.no  # midlertidig, til du har ekte checkout-url

// Enkel helper som på sikt kan kalle Vipps-API.
// Nå returnerer vi en "fake" URL slik at appen din kan testes med ekte flyt.
async function createVippsSessionForUser(userId, { amount, description }) {
  console.log('🧾 Oppretter Vipps-session for bruker', userId, 'beløp', amount);

  // TODO: Her kan du senere:
  //  1. Hente access token fra Vipps
  //  2. Opprette en payment i Vipps eCom API
  //  3. Lagre orderId i databasen hvis du vil
  //  4. Returnere redirectUrl fra Vipps

  const testUrl =
    process.env.VIPPS_TEST_REDIRECT_URL ||
    'https://vipps.no'; // midlertidig

  const fakeOrderId = `order_${userId}_${Date.now()}`;

  return {
    url: testUrl,
    orderId: fakeOrderId,
    amount,
    description
  };
}

// Brukes av appen når bruker trykker "Betal med Vipps"
app.post(
  "/api/billing/vipps/create-session",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "Ikke innlogget." });
      }

      // Du kan senere støtte flere planer / priser
      const { plan } = req.body || {};
      const amount = plan === 'yearly' ? 79900 : 7900; // i øre, f.eks. 79,00 kr
      const description =
        plan === 'yearly'
          ? 'Grenseløs Reise · Årsabonnement'
          : 'Grenseløs Reise · Månedlig abonnement';

      const session = await createVippsSessionForUser(userId, {
        amount,
        description
      });

      // Her kan du også logge til DB at orderId tilhører userId
      console.log('✅ Vipps-session opprettet:', session);

      res.json({
        ok: true,
        ...session
      });
    } catch (e) {
      console.error("/api/billing/vipps/create-session-feil:", e);
      res.status(500).json({
        error: "Kunne ikke opprette Vipps-betaling. Prøv igjen senere."
      });
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
    const token = await getSpotifyToken();
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

// -------------------------------------------------------
//  ANALYSER ÉN EPISODE → PERSONLIG REISE + LAGRE I MINE REISER
// -------------------------------------------------------
app.post(
  "/api/grenselos/episodes/:id/analyze",
  authMiddleware,
  async (req, res) => {
    try {
      const episodeId = req.params.id;
      const {
        name,
        description,
        userPreferences,  // 💬 fritekst fra brukeren
        useProfile        // bool – bruk profil for tilpasning
      } = req.body ?? {};

      if (!name || !description) {
        return res
          .status(400)
          .json({ error: "Mangler navn eller beskrivelse." });
      }

      console.log("🔥 ANALYZE HIT", {
        episodeId: req.params.id,
        userId: req.user?.id,
        hasName: !!req.body?.name,
        hasDesc: !!req.body?.description,
        prefsLen: (req.body?.userPreferences || "").length,
        useProfile: !!req.body?.useProfile
      });
        
      // 1) Hent evt. profil til prompten
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
          console.warn(
            "Klarte ikke å hente profil til episode-KI-prompt:",
            e.message
          );
        }
      }

      // 2) La KI lage personlig reise basert på episode + ønsker + profil
      const { trip, raw } = await generateTripFromEpisode({
        episodeId,
        name,
        description,
        userPreferences,
        userProfile: profile
      });

      // 3) Lagre som brukerreise (user_episode_trip) i trips-tabellen
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
          gallery
        )
        VALUES ($1,$2,$3,$4,$5,$6,'user_episode_trip',$7,$8)
        RETURNING *
        `,
        [
          req.user.id,
          trip.title || name,
          trip.description || description || null,
          JSON.stringify(trip.stops || []),
          JSON.stringify(trip.packing_list || []),
          JSON.stringify(trip.hotels || []),
          episodeId,
          JSON.stringify([]) // galleri kommer fra canonical / generiske bilder senere
        ]
      );

      const row = insert.rows[0];

      // 4) For direkte bruk i appen: normaliser pakkeliste til klientformat
      const clientPacking = normalizePackingForClient(trip.packing_list || []);

      const savedTrip = {
        ...row,
        stops: trip.stops || [],
        hotels: trip.hotels || [],
        gallery: [],
        packing_list: clientPacking
      };

      console.log("✅ ANALYZE OK", {
        episodeId,
        tripId: row.id,
        stops: (trip.stops || []).length,
        source_type: row.source_type
      });
        
      // 5) Returnér både lagret trip og rå KI-tekst (for debug om du vil)
      res.json({
        ok: true,
        trip: savedTrip,
        raw
      });
    } catch (e) {
      console.error("/api/grenselos/episodes/:id/analyze-feil:", e);
      res.status(500).json({ error: "Analyse og lagring feilet." });
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
    const userId = req.user.id;
    const postId = Number(req.params.id);

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
    const userId = req.user.id;
    const postId = Number(req.params.id);

    if (!postId) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    // 🔐 Hent kun is_admin (IKKE role)
    const u = await query(
      `SELECT is_admin FROM users WHERE id=$1`,
      [userId]
    );

    const isAdmin = u.rows[0]?.is_admin === true;

    // 📄 Finn innlegget
    const p = await query(
      `SELECT id, user_id FROM community_posts WHERE id=$1`,
      [postId]
    );

    const post = p.rows[0];
    if (!post) {
      return res.status(404).json({ error: "Innlegg finnes ikke." });
    }

    // 🔒 Tillat kun admin (eller eier hvis du vil)
    const isOwner = post.user_id === userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Ikke tilgang til å slette dette innlegget." });
    }

    // 🗑️ Slett
    await query(
      `DELETE FROM community_posts WHERE id=$1`,
      [postId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/community/posts/:id DELETE error:", e);
    res.status(500).json({ error: "Kunne ikke slette innlegg." });
  }
});

// Multer / upload-feil → 400 (ikke 500)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message?.includes("tillatt")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// -------------------------------------------------------
//  GLOBAL FEILHANDLER
// -------------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Uventet serverfeil:", err);
  res.status(500).json({ error: "Uventet serverfeil." });
});

// -------------------------------------------------------
//  SERVER START
// -------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Grenseløs Reise backend kjører på port ${PORT}`);
});
