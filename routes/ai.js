// backend/routes/ai.js (ESM)
// -------------------------------------------------------
//  KI-GENERERT REISE + GALLERI
//  - ESM (type: "module")
//  - Router-only (ingen app.* her)
//  - Bruker getOpenAI() (ikke { openai } export)
// -------------------------------------------------------

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";

import { query } from "../services/db/query.js";
import { getOpenAI } from "../services/openai/openaiClient.js";
import { normalizeTripV2 } from "../services/trips/tripSchemaV2.js";
import { generateGalleryForTrip } from "../services/gallery/galleryService.js";

const router = express.Router();

/**
 * Ekstraher JSON fra en LLM-respons (tåler ```json``` blokker og tekst rundt).
 * (Holdes lokalt her for å unngå runtime-feil hvis utils/export ikke er på plass.)
 */
function extractJson(text) {
  if (!text) return null;

  let s = String(text).trim();

  // Strip ```json ... ```
  if (s.startsWith("```")) {
    const lines = s.split("\n");
    lines.shift(); // ```json eller ```
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    s = lines.join("\n").trim();
  }

  // Finn første { ... siste }
  if (!(s.startsWith("{") && s.endsWith("}"))) {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// -------------------------------------------------------
//  KI-GENERERT REISE
//  POST /api/ai/generate-trip
// -------------------------------------------------------
router.post("/generate-trip", authMiddleware, async (req, res) => {
  try {
    const openai = getOpenAI();
    const { sourceUrl, userDescription, useProfile } = req.body || {};

    // --- 1) Hent evt. brukerprofil til prompten ---
    let profile = null;
    if (useProfile && req.user?.id) {
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
          LIMIT 1
          `,
          [req.user.id]
        );
        profile = result.rows?.[0] || null;
      } catch (e) {
        console.warn("Klarte ikke å hente profil til KI-prompt:", e?.message || e);
      }
    }

    // --- 2) Systemprompt ---
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
    { "category": "Klær", "items": ["..."] },
    { "category": "Toalettsaker", "items": ["..."] },
    { "category": "Elektronikk", "items": ["..."] },
    { "category": "Annet", "items": ["..."] }
  ],
  "hotels": [
    {
      "name": "Eksempel Hotel",
      "location": "By / område",
      "description": "Kort hvorfor dette passer til turen.",
      "price_per_night": 1200,
      "url": "https://…"
    }
  ],
  "experiences": [
    {
      "title": "Guidet byvandring",
      "location": "By / område",
      "description": "Kort beskrivelse",
      "booking_url": null,
      "day": 1,
      "price_per_person": null,
      "currency": "NOK"
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
- Kategorinavnene MÅ være akkurat disse.
- Hver kategori SKAL ha 3–10 KONKRETE ting (strenger).
- Ikke bruk "osv.", "diverse" som items.

VIKTIG OM STOPS:
- 3–10 stopp.
- Hvert stopp SKAL ha "name" og "description".
- "day" skal være et positivt heltall.
- Hvis du ikke vet koordinater, sett "lat" og "lng" til null.

VIKTIG OM HOTELS:
- 2–6 forslag totalt.
- Hvert hotell SKAL ha "name".
- "price_per_night" i NOK hvis naturlig, ellers null.
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
        "Lag et konkret reiseforslag (5–7 dager) et sted i Europa, med stopp, pakkeliste i 4 kategorier (Klær, Toalettsaker, Elektronikk, Annet), 2–6 hotellforslag og 4–10 opplevelser.";
    }

    // --- 4) Kall OpenAI ---
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    });

    const aiText = completion.choices?.[0]?.message?.content?.trim() || "";

    // --- 5) Parse JSON ---
    const parsed = extractJson(aiText);

    // --- 6) Normaliser til V2-format (robust) ---
    // normalizeTripV2 tåler både {title,...} og {trip:{...}} best effort.
    const trip = parsed && typeof parsed === "object"
      ? normalizeTripV2(parsed)
      : {
          title: "Reiseforslag fra KI (tekst)",
          description: aiText || null,
          stops: [],
          packing_list: [],
          hotels: [],
          experiences: [],
        };

    return res.json({ ok: true, trip, raw: aiText });
  } catch (e) {
    console.error("[ai] POST /generate-trip error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke generere reiseforslag." });
  }
});

// -------------------------------------------------------
//  KI: GENERER GALLERI
//  POST /api/ai/generate-gallery
// -------------------------------------------------------
router.post("/generate-gallery", authMiddleware, async (req, res) => {
  try {
    const { title, description, stops } = req.body || {};

    const gallery = await generateGalleryForTrip(
      title || null,
      description || null,
      Array.isArray(stops) ? stops : []
    );

    return res.json({ ok: true, gallery });
  } catch (e) {
    console.error("[ai] POST /generate-gallery error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke generere galleri." });
  }
});

export default router;
