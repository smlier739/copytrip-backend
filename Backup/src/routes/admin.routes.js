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
              WHERE source_type = 'grenselos_episode'
                AND source_episode_id = ANY($1)
              ORDER BY source_episode_id ASC, created_at DESC
            `,
            [episodeIds]
          );

          // Bruk NYESTE system-trip per episode som "canonical"
          tripsByEpisodeId = tripsRes.rows.reduce((acc, row) => {
            if (!acc[row.source_episode_id]) {
              acc[row.source_episode_id] = row;
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

