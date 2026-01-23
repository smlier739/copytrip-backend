// backend/services/travelAdvice/inferCountryForTrip.js (ESM)

import { getOpenAI } from "../openai/openaiClient.js";
import { ISO2_TO_NO, normalizeCountryCandidate } from "../geo/countries.js";

function parseStops(stops) {
  let out = stops;
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      out = [];
    }
  }
  return Array.isArray(out) ? out : [];
}

function pickFromV2Stops(stops) {
  const codes = [];

  for (const s of stops) {
    if (!s || typeof s !== "object") continue;

    const cc =
      (typeof s.countryCode === "string" && s.countryCode.trim())
        ? s.countryCode.trim().toUpperCase()
        : (typeof s.country_code === "string" && s.country_code.trim())
        ? s.country_code.trim().toUpperCase()
        : (typeof s?.meta?.countryCode === "string" && s.meta.countryCode.trim())
        ? s.meta.countryCode.trim().toUpperCase()
        : (typeof s?.meta?.original?.countryCode === "string" && s.meta.original.countryCode.trim())
        ? s.meta.original.countryCode.trim().toUpperCase()
        : null;

    if (cc) codes.push(cc);
  }

  if (!codes.length) return null;

  const counts = new Map();
  for (const c of codes) counts.set(c, (counts.get(c) || 0) + 1);

  let best = null;
  let bestN = 0;
  for (const [c, n] of counts.entries()) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }

  if (!best) return null;
  return ISO2_TO_NO[best] || best;
}

function pickFromStopNamePattern(stops) {
  const candidates = [];

  for (const s of stops) {
    if (!s || typeof s !== "object") continue;

    const name = (s.name || s.title || "").toString().trim();
    if (!name) continue;

    const paren = name.match(/\(([^)]+)\)\s*$/);
    if (paren?.[1]) {
      const c = normalizeCountryCandidate(paren[1]);
      if (c) candidates.push(c);
    }

    const split = name.split(/,|–|-/).map((x) => x.trim()).filter(Boolean);
    if (split.length >= 2) {
      const tail = split[split.length - 1];
      const c = normalizeCountryCandidate(tail);
      if (c) candidates.push(c);
    }
  }

  if (!candidates.length) return null;

  const counts = new Map();
  for (const c of candidates) counts.set(c, (counts.get(c) || 0) + 1);

  let best = null;
  let bestN = 0;
  for (const [c, n] of counts.entries()) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }

  return best || null;
}

function buildTravelText(trip, stops) {
  const parts = [];

  if (trip?.title) parts.push(String(trip.title));
  if (trip?.description) parts.push(String(trip.description));

  for (const s of stops) {
    if (!s || typeof s !== "object") continue;
    if (s.name) parts.push(String(s.name));
    if (s.description) parts.push(String(s.description));

    if (s?.meta?.original?.country) parts.push(String(s.meta.original.country));
    if (s?.meta?.original?.countryCode) parts.push(String(s.meta.original.countryCode));
  }

  const txt = parts.map((x) => String(x || "").trim()).filter(Boolean).join("\n\n");
  return txt || null;
}

export async function inferCountryForTrip(trip) {
  if (!trip || typeof trip !== "object") return null;

  const stops = parseStops(trip.stops);

  // 0) v2 countryCode (best)
  const fromCodes = pickFromV2Stops(stops);
  if (fromCodes) return fromCodes;

  // 1) “By, Land” heuristikk
  const fromName = pickFromStopNamePattern(stops);
  if (fromName) return fromName;

  // 2) OpenAI fallback
  const travelText = buildTravelText(trip, stops);
  if (!travelText) return null;

  const openai = getOpenAI();

  const systemPrompt = `
Du får beskrivelse av en reise (tittel, tekst og stopp).
Din jobb er å svare hvilket land reisen PRIMÆRT handler om.

KRAV:
- Svar KUN med landnavnet på norsk (f.eks. "Norge", "Japan", "Italia").
- Ikke forklaring. Ikke flere land.
- Hvis usikker eller flere land: svar nøyaktig "UKJENT".
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: travelText },
      ],
      temperature: 0,
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    return normalizeCountryCandidate(raw) || null;
  } catch (e) {
    console.error("inferCountryForTrip: OpenAI-feil:", e);
    return null;
  }
}
