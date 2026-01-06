// -------------------------------------------------------
//  DEBUG: DB-INFO (hvilken database er Render egentlig koblet til?)
// -------------------------------------------------------
app.get("/debug/uploads", (req, res) => {
  try {
    const files = fs.readdirSync(uploadDir);
    res.json({ uploadDir, count: files.length, files });
  } catch (e) {
    res.status(500).json({ uploadDir, error: e.message });
  }
});

app.get("/api/debug/db-info", async (req, res) => {
  try {
    const r = await query(
      `
      SELECT
        current_database() AS db,
        current_user AS "user",
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        current_schema() AS schema,
        current_setting('search_path') AS search_path
      `
    );

    // Ikke logg passord, men greit å se host fra DATABASE_URL hvis du vil
    const dbUrl = process.env.DATABASE_URL || "";
    const safeDbUrl = dbUrl ? dbUrl.replace(/:(.*?)@/, ":***@") : null;

    res.json({
      ok: true,
      env: {
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        databaseUrlHostHint: safeDbUrl
      },
      db: r.rows[0]
    });
  } catch (e) {
    console.error("/api/debug/db-info error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/debug/db-tables", async (req, res) => {
  try {
    const r = await query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name
      `
    );
    res.json({ ok: true, tables: r.rows });
  } catch (e) {
    console.error("/api/debug/db-tables error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------------------------------------
//  DEBUG: INSPEKTÉR ÉN TRIP + EV. SYSTEM-TRIP
// -------------------------------------------------------

app.get(
  "/api/debug/trip/:id",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const tripId = req.params.id;

      // Hjelper for å parse felt som kan være JSON-string/array/null
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

      // 1) Hent selve trip-en (den du ser i appen under "Lagrede reiser")
      const tripRes = await query(
        `
        SELECT *
        FROM trips
        WHERE id = $1
        `,
        [tripId]
      );

      if (tripRes.rowCount === 0) {
        return res.status(404).json({ error: "Fant ikke trip med denne ID-en." });
      }

      const tripRow = tripRes.rows[0];

      const parsedTrip = {
        ...tripRow,
        stops:        parseJsonArray(tripRow.stops),
        packing_list: parseJsonArray(tripRow.packing_list),
        gallery:      parseJsonArray(tripRow.gallery),
        hotels:       parseJsonArray(tripRow.hotels)
      };

      // 2) Hvis den er knyttet til en Grenseløs-episode:
      //    hent "canonical" system-trip for samme episode
      let systemTripRaw = null;
      let systemTripParsed = null;

      if (tripRow.source_episode_id) {
        const sysRes = await query(
          `
          SELECT *
          FROM trips
          WHERE source_type = 'grenselos_episode'
            AND source_episode_id = $1
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [tripRow.source_episode_id]
        );

        if (sysRes.rowCount > 0) {
          systemTripRaw = sysRes.rows[0];
          systemTripParsed = {
            ...systemTripRaw,
            stops:        parseJsonArray(systemTripRaw.stops),
            packing_list: parseJsonArray(systemTripRaw.packing_list),
            gallery:      parseJsonArray(systemTripRaw.gallery),
            hotels:       parseJsonArray(systemTripRaw.hotels)
          };
        }
      }

      // 3) Returnér alt samlet, så du kan se forskjellen tydelig
      res.json({
        ok: true,
        tripId,
        userTrip: {
          raw: tripRow,
          parsed: parsedTrip
        },
        systemTrip: systemTripRaw
          ? {
              raw: systemTripRaw,
              parsed: systemTripParsed
            }
          : null
      });
    } catch (e) {
      console.error("/api/debug/trip/:id-feil:", e);
      res.status(500).json({ error: "Kunne ikke inspisere trip." });
    }
  }
);


