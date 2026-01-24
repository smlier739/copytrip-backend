// backend/services/ai/episodeTripPlanner.js (ESM)

import { getOpenAI } from "../openai/openaiClient.js";

/**
 * Ekstraher JSON fra en LLM-respons (tåler ```json``` blokker og tekst rundt).
 */
function extractJson(text) {
  if (!text) return null;

  let s = String(text).trim();

  // Strip ```json ... ```
  if (s.startsWith("```")) {
    const lines = s.split("\n");
    lines.shift(); // ```json (eller ```)

    // fjern siste ``` hvis finnes
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) {
      lines.pop();
    }
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

function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normalizeTripStructure(raw) {
  const t = raw && typeof raw === "object" ? raw : {};

  const out = {
    title: typeof t.title === "string" ? t.title.trim() : "",
    description: typeof t.description === "string" ? t.description.trim() : null,
    stops: Array.isArray(t.stops) ? t.stops : [],
    packing_list: Array.isArray(t.packing_list) ? t.packing_list : [],
    hotels: Array.isArray(t.hotels) ? t.hotels : [],
    experiences: Array.isArray(t.experiences) ? t.experiences : [],
  };

  // ---------------- stops ----------------
  out.stops = out.stops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => ({
      day: typeof s.day === "number" && Number.isFinite(s.day) ? s.day : idx + 1,
      name:
        typeof s.name === "string" && s.name.trim()
          ? s.name.trim()
          : typeof s.title === "string" && s.title.trim()
          ? s.title.trim()
          : "",
      description: typeof s.description === "string" ? s.description.trim() : "",
      lat: toNumOrNull(s.lat),
      lng: toNumOrNull(s.lng),
    }))
    .filter((s) => s.name);

  // ---------------- packing_list (4 kategorier, 6–10 items hver) ----------------
  const wantedCats = ["Klær", "Toalettsaker", "Elektronikk", "Annet"];
  const byCat = new Map();

  for (const g of out.packing_list) {
    if (!g || typeof g !== "object") continue;

    const cat = typeof g.category === "string" ? g.category.trim() : "";
    if (!wantedCats.includes(cat)) continue;

    const items = Array.isArray(g.items) ? g.items : [];
    const normalizedItems = items
      .map((x) => String(x ?? "").trim())
      .filter(Boolean);

    if (normalizedItems.length) byCat.set(cat, normalizedItems);
  }

  const defaultItems = {
    Klær: [
      "Vind- og regnjakke (ustabilt vær)",
      "Varmlag / ulltrøye (kvelder kan bli kjølige)",
      "Gode sko (mye gåing/underlag varierer)",
      "2–3 t-skjorter (skift)",
      "Bukse som tåler vær (praktisk)",
      "Caps/solhatt (sol og vind)",
    ],
    Toalettsaker: [
      "Tannbørste og tannkrem (basis)",
      "Deodorant (lange dager)",
      "Solkrem (ute store deler av dagen)",
      "Hånddesinfeksjon/våtsservietter (på farten)",
      "Plaster/gnagsårplaster (mye gåing)",
      "Eventuelle faste medisiner (sikkerhet)",
    ],
    Elektronikk: [
      "Mobil + lader (nødvendig)",
      "Powerbank (lange dager)",
      "Adapter (hvis relevant)",
      "Hodetelefoner (reise/transport)",
      "Offline-kart nedlastet (dekning varierer)",
      "Liten fleruttaks-USB (praktisk på rommet)",
    ],
    Annet: [
      "Pass/ID-kort (reise)",
      "Reiseforsikring (dokumentasjon)",
      "Liten dagstursekk (utflukter)",
      "Vannflaske (hydrering)",
      "Solbriller (lys)",
      "Lite førstehjelpskit (sikkerhet)",
    ],
  };

  out.packing_list = wantedCats.map((cat) => {
    const items = (byCat.get(cat) || []).map((x) => String(x).trim()).filter(Boolean);

    // Krav: 6–10
    let finalItems = items.slice(0, 10);
    if (finalItems.length < 6) {
      const filler = defaultItems[cat] || [];
      for (const f of filler) {
        if (finalItems.length >= 6) break;
        if (!finalItems.includes(f)) finalItems.push(f);
      }
    }

    // hvis fortsatt < 6 (svært edge), pad med generiske, men konkrete
    while (finalItems.length < 6) {
      finalItems.push(`Ekstra: ${cat}-ting (${finalItems.length + 1})`);
    }

    return { category: cat, items: finalItems.slice(0, 10) };
  });

  // ---------------- hotels (2–6) ----------------
  out.hotels = out.hotels
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      name: typeof h.name === "string" ? h.name.trim() : "",
      location: typeof h.location === "string" ? h.location.trim() : null,
      description: typeof h.description === "string" ? h.description.trim() : null,
      price_per_night: toNumOrNull(h.price_per_night),
      // url: behold kun hvis modellen ga en streng; du kan URL-sanitize i egen link-service senere
      url: typeof h.url === "string" && h.url.trim() ? h.url.trim() : null,
    }))
    .filter((h) => h.name)
    .slice(0, 6);

  // ---------------- experiences (4–10) ----------------
  out.experiences = out.experiences
    .filter((e) => e && typeof e === "object")
    .map((e, i) => ({
      title:
        typeof e.title === "string" && e.title.trim()
          ? e.title.trim()
          : typeof e.name === "string" && e.name.trim()
          ? e.name.trim()
          : `Opplevelse ${i + 1}`,
      location: typeof e.location === "string" ? e.location.trim() : null,
      description: typeof e.description === "string" ? e.description.trim() : null,
      booking_url:
        typeof e.booking_url === "string" && e.booking_url.trim()
          ? e.booking_url.trim()
          : null,
      day: typeof e.day === "number" && Number.isFinite(e.day) ? e.day : null,
    }))
    .slice(0, 10);

  // Fallback title
  if (!out.title) out.title = "Reiseforslag fra episode";

  return out;
}

/**
 * Bygger episode-basert reiseforslag i formatet: title/description/stops/packing_list/hotels/experiences
 */
export async function buildEpisodeTripPlan({
  episodeId,
  name,
  description,
  userPreferences,
  userProfile,
}) {
  const openai = getOpenAI();

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
  // Prompt
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
      "lat": null,
      "lng": null
    }
  ],
  "packing_list": [
    { "category": "Klær", "items": [ "..." ] },
    { "category": "Toalettsaker", "items": [ "..." ] },
    { "category": "Elektronikk", "items": [ "..." ] },
    { "category": "Annet", "items": [ "..." ] }
  ],
  "hotels": [
    { "name": "Eksempel Hotel", "location": "By / område", "description": "Kort hvorfor", "price_per_night": 1200, "url": null }
  ],
  "experiences": [
    { "title": "Opplevelse", "location": "By / område", "description": "Kort hvorfor", "booking_url": null, "day": 1 }
  ]
}

KRAV:
- STOPS: 5–10 stopp. day/name/description. lat/lng = null hvis usikker.
- HOTELS: 2–6 forslag totalt. price_per_night = tall i NOK hvis naturlig, ellers null.
- EXPERIENCES: 4–10 totalt. booking_url kun hvis du er 100% sikker på offisiell side, ellers null.
- PACKING_LIST: NØYAKTIG 4 kategorier (Klær, Toalettsaker, Elektronikk, Annet), 6–10 items per kategori.
`.trim();

  const userPrompt = `
GRUNNLAG: Grenseløs-episode

- Episode-ID: ${episodeId}
- Tittel: ${name}
- Beskrivelse:
${description}

BRUKERENS TILPASNING/ØNSKER:
${
  userPreferences && String(userPreferences).trim()
    ? String(userPreferences).trim()
    : "Ingen spesifikke ønsker – lag et balansert forslag."
}

BRUKERPROFIL (hvis tilgjengelig):
${profileText}
`.trim();

  // OpenAI call
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL_EPISODE_PLANNER || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
  });

  const aiText = completion.choices?.[0]?.message?.content?.trim() || "";
  const parsed = extractJson(aiText);

  if (parsed && typeof parsed === "object") {
    return normalizeTripStructure(parsed);
  }

  // Fallback hvis modellen ikke ga parsebar JSON
  return normalizeTripStructure({
    title: name || "Reiseforslag fra episode",
    description: typeof description === "string" ? description : null,
    stops: [],
    packing_list: [],
    hotels: [],
    experiences: [],
  });
}
