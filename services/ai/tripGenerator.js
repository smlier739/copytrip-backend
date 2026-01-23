// backend/services/ai/tripGenerator.js (ESM)

import { getOpenAI } from "../../openai/openaiClient.js"; // 👈 justert path (vanlig i denne strukturen)

// -------------------- helpers --------------------

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^https?:\/\/\S+/i.test(t);
}

function sanitizeUrl(s) {
  if (!isHttpUrl(s)) return null;
  const t = s.trim();
  // enkel guard mot å lagre google-search/maps hvis du vil være streng:
  // if (/google\.(com|no)\/(search|maps)/i.test(t)) return null;
  return t;
}

// Stripp ```json```-blokker + trekk ut JSON substring hvis modellen “prater”
function extractJsonText(raw) {
  let jsonText = String(raw || "{}").trim();

  if (jsonText.startsWith("```")) {
    const lines = jsonText.split("\n");
    lines.shift();
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    jsonText = lines.join("\n").trim();
  }

  if (!(jsonText.startsWith("{") && jsonText.endsWith("}"))) {
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }
  }

  return jsonText;
}

// Robust uthenting av tekst fra Responses API (SDK kan variere)
function getResponseText(response) {
  if (!response) return "";

  // Nyere SDK-er kan ha dette:
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  // Fallback: parse output-array
  const out = response.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    // typisk: { type: "message", content: [{ type:"output_text", text:"..." }] }
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c?.text === "string") text += c.text;
        if (typeof c?.content === "string") text += c.content;
      }
    }

    // noen ganger: item.text
    if (typeof item?.text === "string") text += item.text;
  }

  return String(text || "").trim();
}

function normalizeExperiencesArray(raw, fallbackLocation = "") {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((x) => x && typeof x === "object")
    .map((x, i) => {
      const name =
        (typeof x.name === "string" && x.name.trim())
          ? x.name.trim()
          : (typeof x.title === "string" && x.title.trim())
          ? x.title.trim()
          : (typeof x.activity === "string" && x.activity.trim())
          ? x.activity.trim()
          : `Opplevelse ${i + 1}`;

      const description =
        typeof x.description === "string" ? x.description.trim() : "";

      const location =
        (typeof x.location === "string" && x.location.trim())
          ? x.location.trim()
          : (typeof x.city === "string" && x.city.trim())
          ? x.city.trim()
          : (typeof x.area === "string" && x.area.trim())
          ? x.area.trim()
          : (fallbackLocation || "");

      const rawUrl =
        (typeof x.url === "string" && x.url.trim()) ||
        (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
        (typeof x.booking_url === "string" && x.booking_url.trim()) ||
        (typeof x.link === "string" && x.link.trim()) ||
        (typeof x.external_url === "string" && x.external_url.trim()) ||
        null;

      // Viktig: sysPrompt sier “IKKE bruk Google-søk/Maps-søk-URL”.
      // Derfor: hvis vi ikke har en trygg http(s)-url -> null
      const url = sanitizeUrl(rawUrl);

      const day = typeof x.day === "number" ? x.day : null;

      const price_per_person =
        typeof x.price_per_person === "number"
          ? x.price_per_person
          : (x.price_per_person != null && !isNaN(Number(x.price_per_person)))
          ? Number(x.price_per_person)
          : null;

      const currency =
        typeof x.currency === "string" && x.currency.trim()
          ? x.currency.trim()
          : "NOK";

      return {
        id: (typeof x.id === "string" && x.id.trim()) ? x.id.trim() : `exp-${i}`,
        name,
        description,
        location,
        url, // null hvis usikker
        day,
        price_per_person,
        currency,
      };
    })
    .filter((e) => e.name);
}

/**
 * KI: GENERISK TRIP GENERATOR
 * Returnerer alltid { trip: { title, description, stops, packing_list, experiences } }
 */
export async function generateTripFromAI({ sourceUrl, userDescription, userProfile }) {
  const openai = getOpenAI();

  const profileText = userProfile
    ? `
- Navn: ${userProfile.full_name ?? ""}
- Bosted: ${userProfile.home_city ?? ""}, ${userProfile.home_country ?? ""}
- Født: ${userProfile.birth_year ?? ""}
- Reisestil: ${userProfile.travel_style ?? ""}
- Budsjett: ${userProfile.budget_per_day ?? ""}
- Erfaring: ${userProfile.experience_level ?? ""}
`.trim()
    : "Ingen personlig profil tilgjengelig.";

  const budgetPerDay =
    userProfile?.budget_per_day != null && !isNaN(Number(userProfile.budget_per_day))
      ? Number(userProfile.budget_per_day)
      : null;

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

KRAV:
- trip.stops: helst minst 3 stopp.
- Hvert stopp: day, name, description.
- hotels: 1–3 per stopp (ikke tom), approx_price_per_night tall, url kun hvis du er sikker ellers null.
- experiences: trip.experiences 4–10 totalt. url kun hvis du er sikker ellers null.
- IKKE bruk Google-søk/Google Maps-søk-URL.
- packing_list: 8–12 konkrete ting.
`.trim();

  const userPrompt = `
Lag et konkret reiseforslag basert på dette:

Brukerens forespørsel:
${userDescription || ""}

Kilde-URL (kan være null):
${sourceUrl || "ingen"}

Brukerprofil:
${profileText}
`.trim();

  // Responses API
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL_TRIPGEN || "gpt-4.1-mini",
    input: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 1800,
  });

  const raw = getResponseText(response) || "{}";
  console.log("🧾 Rått KI-svar (før parsing):", raw);

  const jsonText = extractJsonText(raw);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error("❌ Klarte ikke å parse KI-svar som JSON:", e);
    console.error("📄 Innhold som feilet parsing:", jsonText);
    return {
      trip: {
        title: "Reiseforslag",
        description: null,
        stops: [],
        packing_list: [],
        experiences: [],
      },
      raw,
    };
  }

  // -------------------------
  // Defensiv normalisering
  // -------------------------
  if (!parsed || typeof parsed !== "object") parsed = {};
  if (!parsed.trip || typeof parsed.trip !== "object") parsed.trip = {};

  const trip = parsed.trip;

  if (!Array.isArray(trip.stops)) trip.stops = [];
  if (!Array.isArray(trip.packing_list)) trip.packing_list = [];
  if (!Array.isArray(trip.experiences)) trip.experiences = [];

  // title/description
  trip.title =
    (typeof trip.title === "string" && trip.title.trim())
      ? trip.title.trim()
      : "Reiseforslag";

  trip.description =
    (typeof trip.description === "string" && trip.description.trim())
      ? trip.description.trim()
      : null;

  // Normaliser stops + sørg for hotels per stop
  trip.stops = trip.stops.map((stop, idx) => {
    const s = stop && typeof stop === "object" ? stop : {};

    const day = (typeof s.day === "number" && Number.isFinite(s.day))
      ? s.day
      : (idx + 1);

    const name =
      (typeof s.name === "string" && s.name.trim())
        ? s.name.trim()
        : `Stopp ${idx + 1}`;

    const description =
      (typeof s.description === "string" && s.description.trim())
        ? s.description.trim()
        : "";

    const lat = (typeof s.lat === "number" && Number.isFinite(s.lat)) ? s.lat : null;
    const lng = (typeof s.lng === "number" && Number.isFinite(s.lng)) ? s.lng : null;

    let hotels = Array.isArray(s.hotels) ? s.hotels : [];
    hotels = hotels
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        name: (typeof h.name === "string" && h.name.trim()) ? h.name.trim() : "",
        approx_price_per_night:
          (typeof h.approx_price_per_night === "number" && Number.isFinite(h.approx_price_per_night))
            ? h.approx_price_per_night
            : (!isNaN(Number(h.approx_price_per_night)) ? Number(h.approx_price_per_night) : defaultHotelPrice),
        currency: (typeof h.currency === "string" && h.currency.trim()) ? h.currency.trim() : "NOK",
        notes: (typeof h.notes === "string" && h.notes.trim()) ? h.notes.trim() : "",
        url: sanitizeUrl(h?.url), // null hvis ugyldig/usikker
      }))
      .filter((h) => h.name);

    if (hotels.length === 0) {
      hotels = [
        {
          name: `Budsjett-hotell i ${name}`,
          approx_price_per_night: defaultHotelPrice,
          currency: "NOK",
          notes: "Forslag generert uten sikker lenke – velg etter beliggenhet og omtaler.",
          url: null,
        },
        {
          name: `Sentral overnatting i ${name}`,
          approx_price_per_night: Math.round(defaultHotelPrice * 1.2),
          currency: "NOK",
          notes: "Alternativ nær sentrum/transport – sjekk tilgjengelighet i booking.",
          url: null,
        },
      ];
    }

    const stopExperiences = normalizeExperiencesArray(s.experiences, name);

    return {
      ...s,
      day,
      name,
      description,
      lat,
      lng,
      hotels,
      experiences: stopExperiences,
    };
  });

  // Normaliser trip.experiences
  let tripExperiences = normalizeExperiencesArray(trip.experiences, "");

  // Hvis modellen la experiences på stopp men ikke på trip → løft opp
  if (tripExperiences.length === 0) {
    const lifted = [];
    for (const s of trip.stops) {
      if (Array.isArray(s.experiences)) lifted.push(...s.experiences);
    }
    tripExperiences = lifted.slice(0, 12);
  }

  // Fallback hvis fortsatt tomt (uten søk-URL; url=null)
  if (tripExperiences.length === 0 && trip.stops.length > 0) {
    const firstStopName = (trip.stops[0]?.name || "").toString().trim();
    tripExperiences = [
      {
        id: "exp-fallback-1",
        name: "Guidet opplevelse / byvandring",
        description: "Sjekk tilgjengelige turer og billetter i området.",
        location: firstStopName || "",
        url: null,
        day: 1,
        price_per_person: null,
        currency: "NOK",
      },
      {
        id: "exp-fallback-2",
        name: "Museum / attraksjon",
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        location: firstStopName || "",
        url: null,
        day: 1,
        price_per_person: null,
        currency: "NOK",
      },
    ];
  }

  trip.experiences = tripExperiences;

  // packing_list: sørg for array av strenger (trim)
  trip.packing_list = (Array.isArray(trip.packing_list) ? trip.packing_list : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);

  return { trip, raw };
}
