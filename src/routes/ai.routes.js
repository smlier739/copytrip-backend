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

