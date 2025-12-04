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

dotenv.config({ override: true });

// ESM-vennlig __dirname / __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Debug API-nøkkel (kun prefix)
console.log(
  "DEBUG OPENAI_API_KEY prefix:",
  (process.env.OPENAI_API_KEY || "").slice(0, 12) || "IKKE SATT"
);

const { Pool } = pkg;

// -------------------------------------------------------
//  APP + DATABASE + OPENAI
// -------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Filopplasting for galleri / virtuell reise ----------

// Sørg for at uploads-mappen finnes
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Konfigurer multer til å lagre bilder lokalt
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const safeOriginalName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${unique}-${safeOriginalName}`);
  }
});

const upload = multer({
  storage,
  // enkel filtrering: bare bilder
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Kun bildefiler er tillatt."), false);
    }
  }
});

// Gjør /uploads tilgjengelig som statiske filer
app.use("/uploads", express.static(uploadDir));

const PORT = process.env.PORT || 4000;

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

  const packing_list = Array.isArray(rawPacking)
    ? rawPacking.map((group) => {
        const category =
          typeof group.category === "string" && group.category.trim()
            ? group.category.trim()
            : "Generelt";

        let items = group.items;
        if (!Array.isArray(items)) {
          // Hvis KI sender streng, splitt på komma / linjeskift
          if (typeof items === "string") {
            items = items
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter(Boolean);
          } else {
            items = [];
          }
        }

        return {
          category,
          items
        };
      })
    : [];

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
    req.user = { id: decoded.userId };
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

    const sysPrompt = `
  Du er en reiseplanlegger for appen "Grenseløs Reise".

  DU MÅ ALLTID svare med REN JSON (ingen forklaringstekst utenfor JSON).

  Struktur:

  {
    "trip": {
      "title": "Kort tittel på reisen",
      "description": "Kort introduksjon til reisen (2–5 linjer)",
      "stops": [
        {
          "day": 1,
          "name": "Navn på stopp eller dag",
          "description": "Kort beskrivelse av hva man gjør / opplever på dette stoppet",
          "lat": null,
          "lng": null,
          "hotels": [
            {
              "name": "Navn på hotell eller overnatting",
              "approx_price_per_night": 1200,
              "currency": "NOK",
              "notes": "Kort begrunnelse (f.eks. nær sentrum, frokost inkludert)"
            }
          ]
        }
      ],
      "packing_list": [
        "En konkret ting å pakke",
        "En annen konkret ting"
      ]
    }
  }

  KRAV FOR STOPS:
  - "trip.stops" SKAL være en liste (array).
  - "trip.stops" SKAL inneholde minst 3, gjerne flere, stopp hvis det er mulig ut fra beskrivelsen.
  - Hvert stopp SKAL ha "name" og "description".
  - "day" skal være et positivt heltall som angir rekkefølgen (1, 2, 3 ...).
  - Hvis du ikke har sikre koordinater, sett "lat" og "lng" til null.

  KRAV FOR HOTELS:
  - Hvert stopp KAN ha en "hotels"-liste.
  - "hotels" SKAL være en liste (array) med 1–3 forslag per stopp.
  - Hvert hotell SKAL ha "name".
  - "approx_price_per_night" skal være et tall (omtrentlig pris per natt).
  - "currency" skal normalt være "NOK" for norske brukere, ellers relevant lokal valuta.
  - Forslagene skal så langt som mulig ligge INNENFOR brukerens dagsbudsjett, basert på "budget_per_day" i profilen.
  - Hvis budsjettet er lavt, prioriter rimelige og enkle alternativer (hostel, budsjett-hotell, enklere gjestehus).

  KRAV FOR PACKING_LIST:
  - "trip.packing_list" SKAL være en liste (array) med minst 8–12 elementer.
  - Hvert element SKAL være én konkret gjenstand eller type utstyr som kan pakkes i en sekk eller koffert.
  - Ikke skriv generelle kategorier som "annet", "diverse", "osv." eller lignende.
  - Unngå duplisering.
  - Tilpass pakkelista til typen reise (klima, aktivitet, varighet).
  `;
  const userPrompt = `
Lag et konkret reiseforslag basert på denne informasjonen.

Brukerens forespørsel / episodebeskrivelse:
${userDescription}

Kilde-URL (kan være null):
${sourceUrl || "ingen"}

Brukerprofil (kan være begrenset):
${profileText}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 1200
  });

  const raw = response.output?.[0]?.content?.[0]?.text || "{}";
  console.log("🧾 Rått KI-svar (før parsing):", raw);

  let jsonText = raw.trim();

  // 1) Stripp ev. ```json```-blokker
  if (jsonText.startsWith("```")) {
    // fjern første linje (``` eller ```json) og siste ```-linje hvis den finnes
    const lines = jsonText.split("\n");
    // dropp første linje
    lines.shift();
    // hvis siste linje starter med ``` – dropp den
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) {
      lines.pop();
    }
    jsonText = lines.join("\n").trim();
  }

  // 2) Hvis det fortsatt er tekst rundt, ta ut substring mellom første { og siste }
  if (!(jsonText.trim().startsWith("{") && jsonText.trim().endsWith("}"))) {
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
    // I stedet for å krasje hele endepunktet, returner en tom, men gyldig struktur:
    return {
      trip: {
        title: "Reiseforslag",
        description: null,
        stops: [],
        packing_list: []
      }
    };
  }

  // Defensiv normalisering
  if (!parsed.trip || typeof parsed.trip !== "object") {
    parsed.trip = {};
  }
  if (!Array.isArray(parsed.trip.stops)) {
    parsed.trip.stops = [];
  }
  if (!Array.isArray(parsed.trip.packing_list)) {
    parsed.trip.packing_list = [];
  }

    // Sørg for at hver stopp har en hotels-liste (selv om tom)
    parsed.trip.stops = parsed.trip.stops.map((stop) => ({
      ...stop,
      hotels: Array.isArray(stop.hotels) ? stop.hotels : []
    }));
    
  return parsed;
}

// -------------------------------------------------------
//  KI: EPISODE-BASERT TRIP
// -------------------------------------------------------

async function generateTripFromEpisode({ episodeId, name, description }) {
  const prompt = `
Lag et konkret reiseforslag inspirert av Grenseløs-episoden:

ID: ${episodeId}
Tittel: ${name}
Beskrivelse: ${description}

Returner KUN JSON:
{
  "title": "...",
  "description": "...",
  "stops": [ ... ]
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Du svarer med ren JSON.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  });

  let text = completion.choices[0]?.message?.content?.trim() || "{}";
  if (text.startsWith("```")) {
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  }
  return JSON.parse(text);
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
        gallery
      )
      VALUES ($1,$2,$3,$4,$5,$6,'grenselos_episode',$7,$8)
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
      JSON.stringify([])   // galleri fylles KUN via admin-endepunktene
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
    `SELECT is_premium, free_trip_limit FROM users WHERE id=$1`,
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
//  AUTH
// -------------------------------------------------------

app.post("/api/auth/signup", async (req, res) => {
  const { email, password, fullName } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "E-post og passord må fylles ut." });
  }

  try {
    const exists = await query("SELECT id FROM users WHERE email=$1", [
      email.toLowerCase(),
    ]);

    if (exists.rowCount > 0) {
      return res.status(400).json({ error: "E-posten er allerede i bruk." });
    }

    const hash = await bcrypt.hash(password, 10);

    const insert = await query(
      `
      INSERT INTO users (email, password_hash, full_name)
      VALUES ($1,$2,$3)
      RETURNING id,email,full_name,created_at
      `,
      [email.toLowerCase(), hash, fullName || null]
    );

    const user = insert.rows[0];

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d",
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
        WHERE id = $1
        `,
        [tripId]
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

  try {
    const result = await query("SELECT * FROM users WHERE email=$1", [
      email.toLowerCase(),
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const token = jwt.sign({ userId: row.id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ token, user: sanitizeUser(row) });
  } catch (e) {
    console.error("Login-feil:", e);
    res.status(500).json({ error: "Kunne ikke logge inn." });
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
            WHERE source_type = 'grenselos_episode'   -- 👈 viktig filter
              AND source_episode_id = ANY($1)
              AND user_id = $2                        -- per-admin maler (kan droppes hvis global)
            ORDER BY source_episode_id ASC, created_at ASC
          `,
          [episodeIds, req.user.id]
        );

        tripsByEpisodeId = tripsRes.rows.reduce((acc, row) => {
          if (!acc[row.source_episode_id]) {
            acc[row.source_episode_id] = row; // bruk den eldste / første mal-trippen
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

    // --- 2) Systemprompt: nå med PACKING_LIST + HOTELS ---
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
        "Vindjakke",
        "Gode joggesko",
        "To ekstra t-skjorter"
      ]
    },
    {
      "category": "Annet",
      "items": [
        "Hodetelefoner",
        "Powerbank"
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

VIKTIG:
- Alltid gyldig JSON (ingen kommentarer, ingen trailing-komma).
- Bruk helst 3–10 stopp.
- Hvis du ikke vet koordinater, sett "lat" og "lng" til null.
- Hvis du er usikker på hotell, foreslå likevel 2–4 steder per reise,
  men pris kan være null hvis du ikke vet.
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
        "Lag et konkret reiseforslag (5–7 dager) et sted i Europa, med stopp, pakkeliste og 2–4 hotellforslag.";
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

// -------------------------------------------------------
//  TRIPS — brukerreiser + fallback til episode-galleri/hoteller
// -------------------------------------------------------

app.get("/api/trips", authMiddleware, async (req, res) => {
  try {
    // 1) Hent brukerreiser (ikke selve system-reisene)
    const baseRes = await query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
        AND (
          source_type IS NULL               -- vanlige KI-/manuelle reiser
          OR source_type = 'template'       -- maler
          OR source_type = 'user_episode_trip' -- reiser laget fra episode
        )
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const rows = baseRes.rows || [];

    // 2) Finn alle episoder disse reisene evt. peker på
    const episodeIds = [
      ...new Set(
        rows
          .map((r) => r.source_episode_id)
          .filter((id) => typeof id === "string" && id.trim() !== "")
      )
    ];

    // Hjelper: parse et felt som kan være JSON-string, array eller null
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

    let canonicalByEpisodeId = {};

    if (episodeIds.length > 0) {
      // 3) Hent canonical galleri / hoteller / pakkeliste fra SYSTEM-TRIPS
      const canonRes = await query(
        `
          SELECT
            source_episode_id,
            gallery,
            hotels,
            packing_list
          FROM trips
          WHERE source_type = 'grenselos_episode'
            AND source_episode_id = ANY($1)
            AND user_id = $2
        `,
        [episodeIds, req.user.id]
      );

      canonicalByEpisodeId = canonRes.rows.reduce((acc, row) => {
        const episodeId = row.source_episode_id;
        if (!episodeId) return acc;

        acc[episodeId] = {
          gallery: parseJsonArray(row.gallery),
          hotels: parseJsonArray(row.hotels),
          packing_list: parseJsonArray(row.packing_list)
        };
        return acc;
      }, {});
    }

    // 4) Normaliser alle brukerreiser + legg inn *overstyrende* fallback
    const trips = rows.map((row) => {
      let stops   = parseJsonArray(row.stops);
      let packing = parseJsonArray(row.packing_list);
      let gallery = parseJsonArray(row.gallery);
      let hotels  = parseJsonArray(row.hotels);

      const episodeId = row.source_episode_id;

      // 🔁 Hvis denne reisen er basert på en Grenseløs-episode,
      // overstyr galleri/hotels/packing_list med canonical data
      if (episodeId && canonicalByEpisodeId[episodeId]) {
        const canon = canonicalByEpisodeId[episodeId];

        gallery = parseJsonArray(canon.gallery);
        hotels  = parseJsonArray(canon.hotels);
        packing = parseJsonArray(canon.packing_list);
      }

      return {
        ...row,
        stops,
        packing_list: packing,
        gallery,
        hotels
      };
    });

    res.json({ trips });
  } catch (e) {
    console.error("/api/trips GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente reiser." });
  }
});

app.post("/api/trips", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      description,
      stops,
      packing_list,
      hotels,
      source_type,
      source_episode_id // 👈 fra klient
    } = req.body ?? {};

    if (!title || !Array.isArray(stops)) {
      return res
        .status(400)
        .json({ error: "Mangler title eller stops (array) i request body." });
    }

    // Kvote-sjekk
    const { isPremium, tripCount, freeLimit } = await getUserTripStats(req.user.id);

    if (!isPremium && tripCount >= freeLimit) {
      return res.status(402).json({
        error: "Gratisgrensen er nådd.",
        code: "FREE_LIMIT_REACHED",
        details: { tripCount, freeLimit }
      });
    }

    // ---------- Normaliser innkommende data ----------
    let finalStops   = Array.isArray(stops) ? stops : [];
    let finalPacking = Array.isArray(packing_list) ? packing_list : [];
    let finalHotels  = Array.isArray(hotels) ? hotels : [];
    let finalGallery = [];
    let sourceType   = null;

    // Hjelper for å parse ev. JSON-strenger fra DB
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

    // ---------- Hvis reisen er knyttet til en Grenseløs-episode ----------
    if (source_episode_id) {
      sourceType = "user_episode_trip";

      // 1) Forsøk å arve fra system-trip i trips-tabellen
      const sysRes = await query(
        `
          SELECT packing_list, hotels, gallery
          FROM trips
          WHERE user_id = $1
            AND source_type = 'grenselos_episode'
            AND source_episode_id = $2
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [req.user.id, source_episode_id]
      );

      if (sysRes.rowCount > 0) {
        const sys = sysRes.rows[0];

        if (!finalPacking.length) {
          finalPacking = parseArrayField(sys.packing_list);
        }
        if (!finalHotels.length) {
          finalHotels = parseArrayField(sys.hotels);
        }

        const g = parseArrayField(sys.gallery);
        if (Array.isArray(g) && g.length) {
          finalGallery = g;
        }
      }
    } else {
      // Vanlige KI-/manuelle reiser
      sourceType = source_type || null;
    }

    // ---------- Lagre reisen ----------
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
        JSON.stringify(finalGallery)
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
      WHERE user_id=$1 AND source='template'
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
//  ANALYSER ÉN EPISODE
// -------------------------------------------------------

app.post("/api/grenselos/episodes/:id/analyze", async (req, res) => {
  try {
    const { name, description } = req.body ?? {};

    if (!name || !description)
      return res.status(400).json({ error: "Mangler navn eller beskrivelse." });

    const data = await generateTripFromEpisode({
      episodeId: req.params.id,
      name,
      description,
    });

    res.json({ trip: data });
  } catch (e) {
    console.error("episode analyze-feil:", e);
    res.status(500).json({ error: "Analyse feilet." });
  }
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
  console.log(`🚀 Grenseløs Reise backend kjører på http://localhost:${PORT}`);
});
