// backend/src/utils/ai.js

export function extractJson(text) {
  if (!text) return null;

  // 1) Prøv å parse hele teksten direkte
  try {
    return JSON.parse(text);
  } catch {}

  // 2) ```json ... ```-blokk
  const codeBlockMatch = text.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // 3) Første {...}-blokk
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {}
  }

  return null;
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

  // -------------------------
  // Prompt
  // -------------------------
  const systemPrompt = `
Du er en erfaren reiseplanlegger som lager konkrete reiseforslag basert på
Grenseløs-episoder OG brukerens ønsker.

Du MÅ ALLTID svare med gyldig JSON, uten forklaringstekst rundt.

Returner strukturert JSON med “title”, “description”, “stops”, “packing_list”, “hotels” og “experiences”.

“experiences” er en array av opplevelser/aktiviteter som ofte krever billett/booking.
Hver experience må ha: title, location, description, og helst booking_url (hvis du er sikker), ellers null.

Output-format (MÅ MATCHES):

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

KRAV FOR PACKING_LIST:
- "packing_list" SKAL ALLTID være en liste med NØYAKTIG 4 elementer.
- De 4 elementene SKAL ha "category" lik:
    1) "Klær"
    2) "Toalettsaker"
    3) "Elektronikk"
    4) "Annet"
- Kategorinavnene må være akkurat disse.
- Hver kategori SKAL ha en "items"-liste med 3–10 KONKRETE ting.

KRAV FOR STOPS:
- 3–10 stopp.
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
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7
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

  // ✅ Experiences: normaliser + fallback url
  // Støtter både trip.experiences og parsed.experiences, siden normalizeTripStructure kan flytte rundt.
  const rawExperiences =
    Array.isArray(trip.experiences) ? trip.experiences :
    Array.isArray(parsed?.experiences) ? parsed.experiences :
    [];

  trip.experiences = normalizeExperiencesArray(rawExperiences);

  // ✅ Hvis modellen ga 0 experiences, legg inn en liten fallback basert på første stopp
  if (trip.experiences.length === 0) {
    const firstStop = Array.isArray(trip.stops) && trip.stops[0] ? trip.stops[0] : null;
    const loc = (firstStop?.name || "").toString().trim();
    trip.experiences = [
      {
        id: `exp-${episodeId}-fallback-1`,
        name: "Guidet opplevelse / byvandring",
        location: loc,
        description: "Sjekk tilgjengelige turer og billetter i området.",
        url: makeTicketSearchUrl("Guidet tur", loc),
        day: typeof firstStop?.day === "number" ? firstStop.day : 1,
        price_per_person: null,
        currency: "NOK"
      },
      {
        id: `exp-${episodeId}-fallback-2`,
        name: "Museum / attraksjon",
        location: loc,
        description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
        url: makeTicketSearchUrl("Museum", loc),
        day: typeof firstStop?.day === "number" ? firstStop.day : 1,
        price_per_person: null,
        currency: "NOK"
      }
    ];
  }

  return { trip, raw: aiText };
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
