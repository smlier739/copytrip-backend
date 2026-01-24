// backend/services/ai/tripFromEpisode.js (ESM)

import { getOpenAI } from "../openai/openaiClient.js"; 

// -------------------- helpers --------------------

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^https?:\/\/\S+/i.test(t);
}

function sanitizeUrl(s) {
  if (!isHttpUrl(s)) return null;
  return s.trim();
}

// Ticket/booking fallback (IKKE Google Maps)
function makeTicketSearchUrl(title, location) {
  const t = (title || "").toString().trim();
  const loc = (location || "").toString().trim();
  if (!t) return null;
  const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
  return `https://www.google.com/search?q=${q}`;
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

  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const out = response.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c?.text === "string") text += c.text;
        if (typeof c?.content === "string") text += c.content;
      }
    }
    if (typeof item?.text === "string") text += item.text;
  }
  return String(text || "").trim();
}

function normalizeExperiencesArray(raw, episodeId, fallbackLocation = "") {
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

      const location =
        (typeof x.location === "string" && x.location.trim())
          ? x.location.trim()
          : (typeof x.city === "string" && x.city.trim())
          ? x.city.trim()
          : (typeof x.area === "string" && x.area.trim())
          ? x.area.trim()
          : (fallbackLocation || "");

      const description =
        (typeof x.description === "string" && x.description.trim())
          ? x.description.trim()
          : "";

      const rawUrl =
        (typeof x.url === "string" && x.url.trim()) ||
        (typeof x.booking_url === "string" && x.booking_url.trim()) ||
        (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
        (typeof x.link === "string" && x.link.trim()) ||
        (typeof x.external_url === "string" && x.external_url.trim()) ||
        null;

      // Her velger vi: ekte url hvis mulig, ellers fallback til google-søk (ikke Maps).
      const url = sanitizeUrl(rawUrl) || makeTicketSearchUrl(name, location);

      const day = typeof x.day === "number" && Number.isFinite(x.day) ? x.day : null;

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
        id: (typeof x.id === "string" && x.id.trim())
          ? x.id.trim()
          : `exp-ep-${episodeId || "unknown"}-${i}`,
        name,
        location,
        description,
        url,
        day,
        price_per_person,
        currency,
      };
    })
    .filter((e) => e.name);
}

function normalizeHotelsArray(raw, episodeId, defaultHotelPrice, fallbackPlace = "") {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((h) => h && typeof h === "object")
    .map((h, i) => {
      const name =
        (typeof h.name === "string" && h.name.trim())
          ? h.name.trim()
          : (typeof h.title === "string" && h.title.trim())
          ? h.title.trim()
          : `Overnatting ${i + 1}`;

      const approx_price_per_night =
        (typeof h.approx_price_per_night === "number" && Number.isFinite(h.approx_price_per_night))
          ? h.approx_price_per_night
          : (!isNaN(Number(h.approx_price_per_night)) ? Number(h.approx_price_per_night) : defaultHotelPrice);

      const currency =
        (typeof h.currency === "string" && h.currency.trim())
          ? h.currency.trim()
          : "NOK";

      const notes =
        (typeof h.notes === "string" && h.notes.trim())
          ? h.notes.trim()
          : "";

      // Behold kun ekte URL; ellers null (du kan lage søk-fallback i klient/API senere)
      const url = sanitizeUrl(h?.url);

      return {
        id: (typeof h.id === "string" && h.id.trim())
          ? h.id.trim()
          : `hotel-ep-${episodeId || "unknown"}-${i}`,
        name,
        approx_price_per_night,
        currency,
        notes,
        url,
        location:
          (typeof h.location === "string" && h.location.trim())
            ? h.location.trim()
            : (fallbackPlace || null),
      };
    })
    .filter((h) => h.name);
}

/**
 * KI: EPISODE-BASERT TRIP
 * Personlig + inspirert av episode
 */
export async function generateTripFromEpisode({
  episodeId,
  name,
  description,
  userPreferences,
  userProfile,
}) {
  const openai = getOpenAI();

  const profileText = userProfile
    ? `
- Navn: ${userProfile.full_name ?? ""}
- Bosted: ${userProfile.home_city ?? ""}, ${userProfile.home_country ?? ""}
- Født: ${userProfile.birth_year ?? ""}
- Reisestil: ${userProfile.travel_style ?? ""}
- Budsjett per dag: ${userProfile.budget_per_day ?? ""}
- Erfaring: ${userProfile.experience_level ?? ""}
`.trim()
    : "Ingen personlig profil tilgjengelig.";

  const preferencesText =
    userPreferences && typeof userPreferences === "object"
      ? JSON.stringify(userPreferences, null, 2)
      : (typeof userPreferences === "string" && userPreferences.trim())
      ? userPreferences.trim()
      : "Ingen eksplisitte preferanser.";

  const budgetPerDay =
    userProfile?.budget_per_day != null && !isNaN(Number(userProfile.budget_per_day))
      ? Number(userProfile.budget_per_day)
      : null;

  const defaultHotelPrice = budgetPerDay
    ? Math.max(500, Math.round(budgetPerDay * 0.7))
    : 1200;

  // -------------------------
  // Prompt
  // -------------------------
  const systemPrompt = `
Du er reiseplanlegger for appen "Grenseløs Reise".

Bruk informasjon fra en konkret podcast-episode for å lage et
PERSONLIG, realistisk reiseforslag inspirert av episoden.

KRAV:
- Svar KUN med REN JSON (ingen tekst utenfor JSON).
- Ikke forklar hva du gjør.
- Vær konkret, jordnær og praktisk.
- Reisen skal føles som "Johnny har vært der".

STRUKTUR:

{
  "trip": {
    "title": "Kort, konkret tittel",
    "description": "Kort intro (2–4 linjer)",
    "stops": [
      {
        "day": 1,
        "name": "Sted",
        "description": "Hva skjer her",
        "lat": null,
        "lng": null,
        "hotels": [
          {
            "name": "Overnatting",
            "approx_price_per_night": 1200,
            "currency": "NOK",
            "notes": "Hvorfor dette stedet",
            "url": null
          }
        ],
        "experiences": [
          {
            "name": "Opplevelse",
            "description": "Hva/hvorfor",
            "location": "Sted",
            "day": 1,
            "url": null,
            "price_per_person": null,
            "currency": "NOK"
          }
        ]
      }
    ],
    "experiences": [],
    "packing_list": []
  }
}

REGLER:
- 3–6 stopp hvis mulig
- Hoteller: 1–2 per stopp
- Experiences: konkrete, ikke turistbrosjyre
- Packing_list: tilpasset klima, stil og episode
`.trim();

  const userPrompt = `
Podcast-episode:
Tittel: ${name || ""}
Beskrivelse:
${description || ""}

Brukerprofil:
${profileText}

Brukerpreferanser:
${preferencesText}
`.trim();

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL_EPISODE || "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 1600,
  });

  const rawText = getResponseText(response) || "{}";
  const jsonText = extractJsonText(rawText);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error("❌ Episode-trip: kunne ikke parse JSON:", e);
    console.error("📄 Innhold som feilet parsing:", jsonText);
    return {
      trip: {
        title: name || "Reise inspirert av episode",
        description: null,
        stops: [],
        experiences: [],
        packing_list: [],
      },
      raw: rawText,
    };
  }

  // -------------------------
  // Defensiv normalisering
  // -------------------------
  if (!parsed || typeof parsed !== "object") parsed = {};
  if (!parsed.trip || typeof parsed.trip !== "object") parsed.trip = {};

  const trip = parsed.trip;

  if (!Array.isArray(trip.stops)) trip.stops = [];
  if (!Array.isArray(trip.experiences)) trip.experiences = [];
  if (!Array.isArray(trip.packing_list)) trip.packing_list = [];

  // stops
  trip.stops = trip.stops.map((s, idx) => {
    const stop = s && typeof s === "object" ? s : {};

    const day =
      (typeof stop.day === "number" && Number.isFinite(stop.day))
        ? stop.day
        : (idx + 1);

    const stopName =
      (typeof stop.name === "string" && stop.name.trim())
        ? stop.name.trim()
        : `Stopp ${idx + 1}`;

    const stopDesc =
      (typeof stop.description === "string" && stop.description.trim())
        ? stop.description.trim()
        : "";

    const lat = (typeof stop.lat === "number" && Number.isFinite(stop.lat)) ? stop.lat : null;
    const lng = (typeof stop.lng === "number" && Number.isFinite(stop.lng)) ? stop.lng : null;

    // hotels: 1–2 per stopp, aldri tom (fallback)
    let hotels = normalizeHotelsArray(stop.hotels, episodeId, defaultHotelPrice, stopName);
    if (hotels.length === 0) {
      hotels = [
        {
          id: `hotel-ep-${episodeId || "unknown"}-${idx}-a`,
          name: `Budsjett-hotell i ${stopName}`,
          approx_price_per_night: defaultHotelPrice,
          currency: "NOK",
          notes: "Forslag uten sikker lenke – velg etter beliggenhet og omtaler.",
          url: null,
          location: stopName,
        },
      ];
    } else {
      hotels = hotels.slice(0, 2);
    }

    // stop.experiences
    const stopExperiences = normalizeExperiencesArray(stop.experiences, episodeId, stopName).slice(0, 3);

    return {
      ...stop,
      day,
      name: stopName,
      description: stopDesc,
      lat,
      lng,
      hotels,
      experiences: stopExperiences,
    };
  });

  // trip.experiences: normaliser + løft fra stopp hvis tom
  let tripExperiences = normalizeExperiencesArray(trip.experiences, episodeId, "");

  if (tripExperiences.length === 0) {
    const lifted = [];
    for (const s of trip.stops) {
      if (Array.isArray(s.experiences)) lifted.push(...s.experiences);
    }
    tripExperiences = lifted.slice(0, 12);
  }

  trip.experiences = tripExperiences;

  // packing_list: sørg for strings
  trip.packing_list = (Array.isArray(trip.packing_list) ? trip.packing_list : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);

  // title/description
  trip.title =
    (typeof trip.title === "string" && trip.title.trim())
      ? trip.title.trim()
      : (name || "Reise inspirert av episode");

  if (typeof trip.description !== "string") trip.description = null;

  return { trip, raw: rawText };
}
