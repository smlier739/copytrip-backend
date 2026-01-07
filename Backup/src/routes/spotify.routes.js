// ---------- Spotify: hent alle Grenseløs-episoder (med paginering) ----------

app.get('/api/grenselos/episodes', async (req, res) => {
  try {
    const token = await getSpotifyAccessToken();
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

// ----------------------------------------------------------------------
// ✅ PREVIEW: Analyser episode -> lag trip (MEN IKKE lagre i DB)
// POST /api/grenselos/episodes/:id/analyze
// Body: { name, description, userPreferences?, useProfile?, episode_url? }
// Return: { ok:true, trip, raw, entitlement }
// ----------------------------------------------------------------------
app.post(
  "/api/grenselos/episodes/:id/analyze",
  authMiddleware,
  async (req, res) => {
    try {
      const episodeId = (req.params.id || "").toString().trim();

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim()
          : "";
      const userPreferences =
        typeof req.body?.userPreferences === "string"
          ? req.body.userPreferences.trim()
          : "";

      const useProfile = req.body?.useProfile !== false; // default true
      const episodeUrl =
        typeof req.body?.episode_url === "string" && req.body.episode_url.trim()
          ? req.body.episode_url.trim()
          : null;

      if (!episodeId) {
        return res.status(400).json({ error: "Mangler episode-id i URL." });
      }
      if (!name || !description) {
        return res.status(400).json({
          error: "Mangler name eller description i request body.",
        });
      }

      // 🔑 Premium/admin: detaljer kan vises (paywall på hoteller/pakkeliste/opplevelser)
      const detailsUnlocked = !!(req.user?.is_admin || req.user?.is_premium);

      // ---------------- Helpers ----------------
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

      const isHttpUrl = (s) => {
        if (typeof s !== "string") return false;
        const t = s.trim();
        return /^https?:\/\/\S+/i.test(t);
      };

      const sanitizeUrl = (s) => (isHttpUrl(s) ? s.trim() : null);

      const makeHotelFallbackUrl = (h) => {
        const name = (h?.name || h?.title || "").toString().trim();
        const location = (h?.location || h?.city || h?.area || "")
          .toString()
          .trim();
        if (!name) return null;
        const q = encodeURIComponent(location ? `${name} ${location}` : name);
        return `https://www.google.com/maps/search/?api=1&query=${q}`;
      };

      const makeExperienceFallbackUrl = (x) => {
        const name = (x?.name || x?.title || "").toString().trim();
        const location = (x?.location || x?.city || x?.area || "")
          .toString()
          .trim();
        if (!name) return null;
        const q = encodeURIComponent(
          location ? `${name} ${location} billetter` : `${name} billetter`
        );
        return `https://www.google.com/search?q=${q}`;
      };

      // 1) Hent profil hvis ønsket
      let userProfile = null;
      if (useProfile) {
        try {
          const profRes = await query(
            `
            SELECT full_name, home_city, home_country, birth_year, travel_style, budget_per_day, experience_level
            FROM users
            WHERE user_id = $1
            LIMIT 1
            `,
            [req.user.id]
          );
          userProfile = profRes.rows?.[0] || null;
        } catch (e) {
          // Profil er optional – ikke fail hele request
          console.warn(
            "Kunne ikke hente profil (fortsetter uten):",
            e?.message || e
          );
          userProfile = null;
        }
      }

      // 2) Generer trip fra episode (IKKE lagre)
      const { trip: generatedTrip, raw } = await generateTripFromEpisode({
        episodeId,
        name,
        description,
        userPreferences,
        userProfile,
      });

      const baseTrip =
        generatedTrip && typeof generatedTrip === "object"
          ? generatedTrip
          : {
              title: name || "Reise fra episode",
              description: null,
              stops: [],
              packing_list: [],
              hotels: [],
              experiences: [],
              gallery: [],
            };

      // 3) Normaliser felter slik klienten alltid får riktig format
      const stops = parseJsonArray(baseTrip.stops);
      const gallery = parseJsonArray(baseTrip.gallery);

      const normalizedHotels = parseJsonArray(baseTrip.hotels)
        .filter((h) => h && typeof h === "object")
        .map((h) => ({
          ...h,
          url:
            sanitizeUrl(h?.url) ||
            sanitizeUrl(h?.booking_url) ||
            sanitizeUrl(h?.link) ||
            sanitizeUrl(h?.external_url) ||
            makeHotelFallbackUrl(h),
        }));

      const normalizedExperiences = parseJsonArray(baseTrip.experiences)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          ...x,
          url:
            sanitizeUrl(x?.url) ||
            sanitizeUrl(x?.booking_url) ||
            sanitizeUrl(x?.ticket_url) ||
            sanitizeUrl(x?.link) ||
            sanitizeUrl(x?.external_url) ||
            makeExperienceFallbackUrl(x),
        }));

      const normalizedPacking = normalizePackingForClient(baseTrip.packing_list);

      // 4) Bygg preview-trip + paywall på detaljer (ikke på antall turer)
      const locked = !detailsUnlocked;

      const previewTrip = {
        ...baseTrip,

        // viktig: ingen "id" her, siden den ikke er lagret
        id: undefined,

        title: baseTrip.title || name || "Reise fra episode",
        stops,
        gallery,

        source_type: "user_episode_trip_preview",
        source_episode_id: episodeId,
        episode_url: episodeUrl,

        // 🔒 Lås detaljene hvis ikke premium/admin
        hotels: locked ? [] : normalizedHotels,
        experiences: locked ? [] : normalizedExperiences,
        packing_list: locked ? [] : normalizedPacking,

        details_locked: locked,
        details_preview: locked
          ? {
              hotels_count: normalizedHotels.length,
              experiences_count: normalizedExperiences.length,
              packing_categories: (normalizedPacking || [])
                .map((g) => g?.category)
                .filter(Boolean)
                .slice(0, 6),
            }
          : null,
      };

      // 5) Returner preview
      return res.json({
        ok: true,
        trip: previewTrip,
        raw: raw || null,
        entitlement: {
          details_unlocked: detailsUnlocked,
          is_premium: !!req.user?.is_premium,
          is_admin: !!req.user?.is_admin,
        },
      });
    } catch (err) {
      console.error(
        "/api/grenselos/episodes/:id/analyze (preview) feil:",
        err
      );
      return res
        .status(500)
        .json({ error: "Kunne ikke analysere episoden." });
    }
  }
);

