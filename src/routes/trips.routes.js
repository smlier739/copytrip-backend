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

app.get("/api/trips/:id/hotels", authMiddleware, requirePro, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await query(
      `SELECT id, source_episode_id, source_type, hotels
       FROM trips
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [tripId, req.user.id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: "Fant ikke denne reisen." });
    }

    const row = tripRes.rows[0];
    let hotels = parseJsonArray(row.hotels);

    // episode-trip: hent canonical hotels
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

    const hotelsFull = (hotels || [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({ ...h, url: makeHotelUrl(h) }));

    return res.json({ ok: true, tripId, hotels: hotelsFull });
  } catch (e) {
    console.error("/api/trips/:id/hotels-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente hoteller." });
  }
});

app.get("/api/trips/:id/experiences", authMiddleware, requirePro, async (req, res) => {
  try {
    const tripId = req.params.id;

    const tripRes = await query(
      `SELECT id, source_episode_id, experiences
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

    const experiencesFull = (experiences || [])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ ...x, url: makeExperienceUrl(x) }));

    return res.json({ ok: true, tripId, experiences: experiencesFull });
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

