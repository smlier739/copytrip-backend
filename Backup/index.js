// backend/index.js – Grenseløs Reise backend

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import OpenAI from 'openai';
import axios from 'axios';

dotenv.config({ override: true });

// Liten debug-logg – viser bare prefix, aldri hele nøkkelen
const keyPrefix = (process.env.OPENAI_API_KEY || '').slice(0, 12);
console.log('DEBUG OPENAI_API_KEY prefix:', keyPrefix || 'IKKE SATT');

const { Pool } = pkg;

// ---------- Konfig ----------

const PORT = process.env.PORT || 4000;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'copytrip_user',
  password: process.env.DB_PASSWORD || 'superhemmelig',
  database: process.env.DB_NAME || 'copytrip'
});

const JWT_SECRET = process.env.JWT_SECRET || 'superhemmelig-dev-token';

// Init OpenAI-klient (project bare hvis satt)
const openaiConfig = {
  apiKey: process.env.OPENAI_API_KEY
};
if (process.env.OPENAI_PROJECT_ID) {
  openaiConfig.project = process.env.OPENAI_PROJECT_ID;
}
const openai = new OpenAI(openaiConfig);

// Hjelpefunksjon: finn eller lag trip for én episode
async function ensureTripForEpisode(episode, userId) {
  const episodeId = episode.id;
  const title = episode.name || 'Uten tittel';
  const description = episode.description || '';

  // Finnes det allerede en trip for denne episoden?
  const existing = await query(
    `SELECT id FROM trips
     WHERE source_type = 'grenselos_episode'
       AND source_episode_id = $1`,
    [episodeId]
  );
  if (existing.rowCount > 0) {
    return existing.rows[0].id;
  }

  // Kall KI for å generere rute + pakkeliste
  const aiRes = await generateTripFromAI({
    sourceUrl: episode.external_url || null,
    userDescription:
      `Lag en komplett reiserute (stopp med lat/lng + beskrivelser) ` +
      `og en pakkeliste basert på denne Grenseløs-episoden.\n\n` +
      `Tittel: ${title}\n\n` +
      `Beskrivelse:\n${description}`,
    useProfile: false
  });

  const trip = aiRes.trip || aiRes;

  const stops = Array.isArray(trip.stops) ? trip.stops : [];
  const packingList = Array.isArray(trip.packing_list)
    ? trip.packing_list
    : (trip.packingList || []);

  const insertRes = await query(
    `
    INSERT INTO trips (
      user_id,
      title,
      description,
      template_json,
      source_type,
      source_episode_id,
      gallery,
      packing_list
    )
    VALUES ($1, $2, $3, $4, 'grenselos_episode', $5, $6, $7)
    RETURNING id
    `,
    [
      userId,
      trip.title || title,
      trip.description || description || null,
      JSON.stringify({ stops }),
      episodeId,
      JSON.stringify([]),            // tomt galleri – fylles i Admin
      JSON.stringify(packingList || [])
    ]
  );

  return insertRes.rows[0].id;
}

// Lett sync ved oppstart – bare nye episoder
app.post('/api/grenselos/sync-new-episodes', authMiddleware, async (req, res) => {
  try {
    const episodesRes = await fetchGrenselosEpisodes(); // det du allerede bruker til /api/grenselos/episodes
    const episodes = episodesRes.episodes || episodesRes || [];

    let created = 0;
    for (const ep of episodes) {
      const existing = await query(
        `SELECT id FROM trips
         WHERE source_type = 'grenselos_episode'
           AND source_episode_id = $1`,
        [ep.id]
      );
      if (existing.rowCount === 0) {
        await ensureTripForEpisode(ep, req.user.id);
        created += 1;
      }
    }

    res.json({ ok: true, created });
  } catch (e) {
    console.error('/api/grenselos/sync-new-episodes-feil:', e);
    res.status(500).json({ error: 'Kunne ikke synkronisere episoder.' });
  }
});

// Full sync når du trykker "Se podkast-reiser" – analyser alle
app.post('/api/grenselos/sync-all-episodes', authMiddleware, async (req, res) => {
  try {
    const episodesRes = await fetchGrenselosEpisodes();
    const episodes = episodesRes.episodes || episodesRes || [];

    const tripIds = [];
    for (const ep of episodes) {
      const tripId = await ensureTripForEpisode(ep, req.user.id);
      tripIds.push(tripId);
    }

    res.json({ ok: true, count: tripIds.length, tripIds });
  } catch (e) {
    console.error('/api/grenselos/sync-all-episodes-feil:', e);
    res.status(500).json({ error: 'Kunne ikke analysere alle episoder.' });
  }
});

// Hent ferdige "podkast-reiser" (brukes av PodcastTripsScreen)
app.get('/api/podcast-trips', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        title,
        description,
        template_json,
        gallery,
        packing_list,
        source_episode_id
      FROM trips
      WHERE source_type = 'grenselos_episode'
      ORDER BY created_at DESC
      `
    );

    const trips = result.rows.map((row) => {
      let templateJson = row.template_json;
      if (typeof templateJson === 'string') {
        try {
          templateJson = JSON.parse(templateJson);
        } catch {
          templateJson = null;
        }
      }
      let gallery = row.gallery;
      if (typeof gallery === 'string') {
        try {
          gallery = JSON.parse(gallery);
        } catch {
          gallery = [];
        }
      }
      let packingList = row.packing_list;
      if (typeof packingList === 'string') {
        try {
          packingList = JSON.parse(packingList);
        } catch {
          packingList = [];
        }
      }

      return {
        id: row.id,
        title: row.title,
        description: row.description,
        templateJson,
        gallery: gallery || [],
        packing_list: packingList || [],
        sourceEpisodeId: row.source_episode_id
      };
    });

    res.json({ trips });
  } catch (e) {
    console.error('/api/podcast-trips GET-feil:', e);
    res.status(500).json({ error: 'Kunne ikke hente podkast-reiser.' });
  }
});


// ---------- Hjelpefunksjoner ----------

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

function sanitizeUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

// ---------- Auth-middleware ----------

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' '); // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Manglende Authorization header.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    console.warn('JWT-feil:', err.message);
    return res.status(401).json({ error: 'Ugyldig eller utløpt token.' });
  }
}

// ---------- Spotify-hjelper ----------

// Hent Spotify access token (Client Credentials Flow)
async function getSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID eller SPOTIFY_CLIENT_SECRET mangler i .env');
  }

  const tokenRes = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
          ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return tokenRes.data.access_token;
}

// ---------- KI-hjelper: lag reise + pakkeliste ----------

async function generateTripFromAI({ sourceUrl, userDescription, userProfile }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Mangler OPENAI_API_KEY i miljøvariabler.');
  }

  const profileText = userProfile
    ? `
Brukerprofil (for å tilpasse forslag):
- Navn: ${userProfile.full_name || 'ukjent'}
- Bosted: ${userProfile.home_city || 'ukjent'}, ${userProfile.home_country || ''}
- Fødselsår: ${userProfile.birth_year || 'ukjent'}
- Reisestil: ${userProfile.travel_style || 'ukjent'}
- Budsjett per dag: ${userProfile.budget_per_day || 'ukjent'}
- Erfaring: ${userProfile.experience_level || 'ukjent'}
`
    : 'Ingen spesifikk profil tilgjengelig. Lag et generelt, men konkret forslag.';

  const sysPrompt = `
Du er en reiseplanlegger for appen "Grenseløs Reise".
Du skal returnere **RENT JSON** (ingen forklaringstekst, ingen markdown).

Du skal gi:

1) Et konkret reiseforslag (trip) med:
   - title (string)
   - description (string)
   - stops: liste av stopp der hvert stopp har:
       - name (string)
       - description (string)
       - lat (number) og lng (number) hvis det er naturlig å angi
       - day (number) hvis relevant (1, 2, 3, ...)

2) En pakkeliste (packing_list) strukturert slik:
   "packing_list": [
     {
       "category": "Dokumenter",
       "items": ["Pass", "Førerkort", "Reiseforsikring"]
     },
     {
       "category": "Klær",
       "items": ["2 bukser", "4 t-skjorter", "1 lett jakke", "undertøy for X dager"]
     },
     ...
   ]

Tilpass pakkelisten til type reise (roadtrip, storby, fjell, nordlys osv.), sesong (hvis du kan gjette),
og eventuelle hint i beskrivelsen. Bruk norske navn på kategorier og ting.
`;

  const userPrompt = `
Lag et konkret reiseforslag med stopp + en tilpasset pakkeliste.

Kilde-URL (kan være null): ${sourceUrl || 'null'}

Brukerbeskrivelse / episodeinfo:
${userDescription}

${profileText}

Returner **kun JSON** på formen:
{
  "trip": {
    "title": "...",
    "description": "...",
    "stops": [
      {
        "name": "...",
        "description": "...",
        "lat": 12.34,
        "lng": 56.78,
        "day": 1
      }
    ]
  },
  "packing_list": [
    {
      "category": "Dokumenter",
      "items": ["Pass", "Førerkort"]
    }
  ]
}
`;

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      {
        role: 'system',
        content: sysPrompt
      },
      {
        role: 'user',
        content: userPrompt
      }
    ],
    max_output_tokens: 1200
  });

  const output = response.output[0]?.content[0]?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (e) {
    console.warn('Kunne ikke parse KI-svar som JSON:', e, output);
    throw new Error('KI-respons i feil format.');
  }

  const trip = parsed.trip || {};
  const packingList = Array.isArray(parsed.packing_list)
    ? parsed.packing_list
    : [];

  return { trip, packingList };
}

// ---------- KI-hjelper for Grenseløs-episoder ----------

async function generateTripFromEpisode({ episodeId, name, description }) {
  const prompt = `
Du er reiseplanlegger for podkasten "Grenseløs".
Du får tittel og beskrivelse av en episode, og skal lage EN konkret reiserute inspirert av episoden.

Gi svaret som ren JSON (ingen forklarende tekst), med dette formatet:

{
  "title": "Kort tittel på reisen",
  "description": "Kort beskrivelse (2-4 setninger) av reisen.",
  "stops": [
    {
      "name": "Navn på stopp",
      "lat": 40.8518,
      "lng": 14.2681,
      "description": "Hva gjør man her, hvorfor er stoppet viktig.",
      "day": 1
    }
  ]
}

REGLER:
- Lag mellom 3 og 8 stopp.
- Hvis du ikke er sikker på nøyaktige koordinater, kan du bruke "lat": null og "lng": null.
- "day" starter på 1 og øker utover i reiseløpet.

Episode-ID: ${episodeId}
Episode-tittel: ${name}
Episode-beskrivelse: ${description}
`.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content:
          'Du er en nøktern, konkret reiseplanlegger. Du svarer alltid med ren JSON uten kommentarer.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7
  });

  const raw = completion.choices[0]?.message?.content?.trim() || '';

  let cleaned = raw;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/```json/gi, '').replace(/```/g, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (e) {
    console.error('Klarte ikke å parse JSON fra KI (episode):', e.message, raw);
    throw new Error('KI svarte ikke med gyldig JSON for episoden.');
  }
}

// ---------- Statisk podkast-trip-liste ----------

const PODCAST_TRIPS = [
  {
    id: 'grenselos-italia-sor',
    title: 'Roadtrip i Sør-Italia',
    episodeTitle: 'Grenseløs – Sør-Italia spesial',
    description:
      'Fra Napoli til Calabria: små landsbyer, kystveier og spontan pizza.',
    hint: 'Basert på en klassisk Sør-Italia-tur fra Grenseløs.',
    templateJson: {
      title: 'Roadtrip i Sør-Italia',
      description:
        'En rute fra Napoli via Amalfikysten og inn i Calabria, med fokus på små steder og rolig tempo.',
      stops: [
        {
          name: 'Napoli',
          lat: 40.8518,
          lng: 14.2681,
          description: 'Start i Napoli: pizza, kaos og ekte italiensk byliv.'
        },
        {
          name: 'Amalfikysten',
          lat: 40.634,
          lng: 14.602,
          description:
            'Kjør langs kystveien, stopp i småbyer og finn egne utsiktspunkter.'
        },
        {
          name: 'Matera',
          lat: 40.6663,
          lng: 16.6043,
          description:
            'Gamle grottebyer, kveldslys og mye historiefølelse. Perfekt for foto.'
        },
        {
          name: 'Calabria-kysten',
          lat: 38.6741,
          lng: 16.098,
          description:
            'Roligere strender, færre turister, mer hverdags-Italia. Avslutt i en liten kystby.'
        }
      ]
    }
  }
  // legg gjerne inn flere her hvis du vil
];

// ---------- App-oppsett ----------

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health-check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------- Auth & profil ----------

// Hent profil til innlogget bruker
app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Ikke innlogget' });
    }

    const { rows } = await query(
      `
      SELECT
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        created_at
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Fant ikke bruker' });
    }

    res.json({ user: rows[0] });
  } catch (e) {
    console.error('/api/profile-feil:', e);
    res.status(500).json({ error: 'Kunne ikke hente profil' });
  }
});

// Oppdatere profil
app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Ikke innlogget' });
    }

    const {
      fullName,
      birthYear,
      homeCity,
      homeCountry,
      travelStyle,
      budgetPerDay,
      experienceLevel
    } = req.body || {};

    const birthYearValue =
      birthYear === null || birthYear === '' || birthYear === undefined
        ? null
        : Number(birthYear);

    const budgetPerDayValue =
      budgetPerDay === null ||
      budgetPerDay === '' ||
      budgetPerDay === undefined
        ? null
        : Number(budgetPerDay);

    const { rows } = await query(
      `
      UPDATE users
      SET
        full_name        = COALESCE($1, full_name),
        birth_year       = $2,
        home_city        = $3,
        home_country     = $4,
        travel_style     = $5,
        budget_per_day   = $6,
        experience_level = $7
      WHERE id = $8
      RETURNING
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        created_at
      `,
      [
        fullName || null,
        birthYearValue,
        homeCity || null,
        homeCountry || null,
        travelStyle || null,
        budgetPerDayValue,
        experienceLevel || null,
        userId
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Fant ikke bruker å oppdatere' });
    }

    res.json({ user: rows[0] });
  } catch (e) {
    console.error('/api/profile/update-feil:', e);
    res.status(500).json({ error: 'Kunne ikke oppdatere profil' });
  }
});

// Opprett konto
app.post('/api/auth/signup', async (req, res) => {
  const body = req.body || {};
  const { email, password, fullName } = body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-post og passord må fylles ut.' });
  }

  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase()
    ]);

    if (existing.rowCount > 0) {
      return res
        .status(400)
        .json({ error: 'Det finnes allerede en bruker med denne e-posten.' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await query(
      `
      INSERT INTO users (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      RETURNING id, email, full_name, birth_year, home_city, home_country,
                travel_style, budget_per_day, experience_level, created_at
      `,
      [email.toLowerCase(), hash, fullName || null]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: '30d'
    });

    res.json({
      token,
      user
    });
  } catch (err) {
    console.error('Signup-feil:', err);
    res.status(500).json({ error: 'Kunne ikke opprette bruker.' });
  }
});

// Logg inn
app.post('/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const { email, password } = body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-post og passord må fylles ut.' });
  }

  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [
      email.toLowerCase()
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Feil e-post eller passord.' });
    }

    const userRow = result.rows[0];
    const valid = await bcrypt.compare(password, userRow.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Feil e-post eller passord.' });
    }

    const token = jwt.sign({ userId: userRow.id }, JWT_SECRET, {
      expiresIn: '30d'
    });

    res.json({
      token,
      user: sanitizeUser(userRow)
    });
  } catch (err) {
    console.error('Login-feil:', err);
    res.status(500).json({ error: 'Kunne ikke logge inn.' });
  }
});

// Enkel /api/me
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, full_name, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Bruker ikke funnet.' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('/api/me GET-feil:', err);
    res.status(500).json({ error: 'Kunne ikke hente profil.' });
  }
});

// Oppdater /api/me (bare navn)
app.put('/api/me', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const { fullName } = body;

  try {
    const result = await query(
      `
      UPDATE users
      SET full_name = COALESCE($1, full_name)
      WHERE id = $2
      RETURNING id, email, full_name, created_at
      `,
      [fullName ?? null, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('/api/me PUT-feil:', err);
    res.status(500).json({ error: 'Kunne ikke oppdatere profil.' });
  }
});

// ---------- KI-basert generering av reise ----------

app.post('/api/ai/generate-trip', authMiddleware, async (req, res) => {
  try {
    const { sourceUrl, userDescription, useProfile } = req.body || {};

    let userProfile = null;
    if (useProfile) {
      const profRes = await query(
        `
        SELECT id, email, full_name, birth_year, home_city, home_country,
               travel_style, budget_per_day, experience_level
        FROM users
        WHERE id = $1
        `,
        [req.user.id]
      );
      userProfile = profRes.rows[0] || null;
    }

    const { trip, packingList } = await generateTripFromAI({
      sourceUrl,
      userDescription,
      userProfile
    });

    // Sørg for at stops alltid er array
    const stops = Array.isArray(trip.stops) ? trip.stops : [];

    res.json({
      trip: {
        title: trip.title || 'Reiseforslag',
        description: trip.description || '',
        stops,
        packing_list: packingList
      }
    });
  } catch (err) {
    console.error('/api/ai/generate-trip-feil:', err);
    res.status(500).json({ error: 'Kunne ikke generere reiseforslag fra KI.' });
  }
});

// ---------- Trips ----------

// Hent alle trips for innlogget bruker
app.get('/api/trips', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const trips = result.rows.map((row) => {
      let stops = row.stops;
      if (typeof stops === 'string') {
        try {
          stops = JSON.parse(stops);
        } catch {
          stops = [];
        }
      }
      if (!Array.isArray(stops)) stops = [];
      return {
        ...row,
        stops,
        stops_count: stops.length
      };
    });

    res.json({ trips });
  } catch (err) {
    console.error('/api/trips GET-feil:', err);
    res.status(500).json({ error: 'Kunne ikke hente reiser.' });
  }
});

// Hent én trip
app.get('/api/trips', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
      [req.user.id]
    );

    const trips = result.rows.map((row) => {
      let stops = row.stops;
      if (typeof stops === 'string') {
        try {
          stops = JSON.parse(stops);
        } catch {
          stops = [];
        }
      }
      if (!Array.isArray(stops)) stops = [];

      let packingList = row.packing_list;
      if (typeof packingList === 'string') {
        try {
          packingList = JSON.parse(packingList);
        } catch {
          packingList = [];
        }
      }
      if (!Array.isArray(packingList)) packingList = [];

      return {
        ...row,
        stops,
        packing_list: packingList,
        stops_count: stops.length
      };
    });

    res.json({ trips });
  } catch (err) {
    console.error('/api/trips GET-feil (robust):', err);
    res.status(500).json({ error: 'Kunne ikke hente reiser.' });
  }
});

// Opprett ny trip (brukes av CopyScreen + manuelt opprettet)
app.post('/api/trips', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const { title, description, stops, packing_list } = body;

  if (!title || !Array.isArray(stops)) {
    return res.status(400).json({
      error: 'Mangler title eller stops (må være array) i request body.'
    });
  }

  try {
    const result = await query(
      `
      INSERT INTO trips (user_id, title, description, stops, packing_list)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, title, description, stops, packing_list, created_at, source
    `,
      [
        req.user.id,
        title,
        description || null,
        JSON.stringify(stops),
        packing_list ? JSON.stringify(packing_list) : null
      ]
    );

    const row = result.rows[0];

    let parsedStops = Array.isArray(stops) ? stops : [];
    let parsedPacking =
      typeof row.packing_list === 'string'
        ? JSON.parse(row.packing_list)
        : row.packing_list || [];

    if (!Array.isArray(parsedPacking)) parsedPacking = [];

    const trip = {
      ...row,
      stops: parsedStops,
      packing_list: parsedPacking,
      stops_count: parsedStops.length
    };

    res.status(201).json({ trip });
  } catch (err) {
    console.error('/api/trips POST-feil:', err);
    res.status(500).json({ error: 'Kunne ikke lagre reisen.' });
  }
});

// Mal-reiser (om du vil bruke det senere)
app.get('/api/templates', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT *
      FROM trips
      WHERE user_id = $1
        AND source = 'template'
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const templates = result.rows.map((row) => {
      let stops = row.stops;
      if (typeof stops === 'string') {
        try {
          stops = JSON.parse(stops);
        } catch {
          stops = [];
        }
      }
      if (!Array.isArray(stops)) stops = [];

      return {
        ...row,
        stops,
        stops_count: stops.length
      };
    });

    res.json({ templates });
  } catch (err) {
    console.error('/api/templates GET-feil:', err);
    res.status(500).json({ error: 'Kunne ikke hente mal-reiser.' });
  }
});

// Slett en reise (kun eier)
app.post('/api/trips/:id/delete', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      'DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Fant ikke reise å slette.' });
    }

    res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error('/api/trips/:id/delete-feil:', err);
    res.status(500).json({ error: 'Kunne ikke slette reisen.' });
  }
});

// Oppdatere galleri for en trip (Admin)
app.post('/api/admin/trips/:id/gallery', authMiddleware, async (req, res) => {
  try {
    // her kan du evt. sjekke at brukeren er admin
    const { id } = req.params;
    const { gallery } = req.body || {};

    if (!Array.isArray(gallery)) {
      return res.status(400).json({ error: 'gallery må være en liste.' });
    }

    const result = await query(
      `
      UPDATE trips
      SET gallery = $2
      WHERE id = $1
      RETURNING id, title, gallery
      `,
      [id, JSON.stringify(gallery)]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Reise ikke funnet.' });
    }

    res.json({ trip: result.rows[0] });
  } catch (e) {
    console.error('/api/admin/trips/:id/gallery-feil:', e);
    res.status(500).json({ error: 'Kunne ikke oppdatere galleri.' });
  }
});

// ---------- Podkast-reiser (statisk) ----------

app.get('/api/podcast-trips', authMiddleware, (req, res) => {
  res.json({ trips: PODCAST_TRIPS });
});

// ---------- Spotify: hent alle Grenseløs-episoder ----------

app.get('/api/grenselos/episodes', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    const showId = process.env.SPOTIFY_SHOW_ID;

    if (!showId) {
      return res
        .status(500)
        .json({ error: 'SPOTIFY_SHOW_ID er ikke satt i .env' });
    }

    const response = await axios.get(
      `https://api.spotify.com/v1/shows/${showId}/episodes`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        params: {
          market: 'NO',
          limit: 50
        }
      }
    );

    const episodes = response.data.items.map((ep) => ({
      id: ep.id,
      name: ep.name,
      description: ep.description,
      release_date: ep.release_date,
      audio_url: ep.audio_preview_url || null,
      external_url: ep.external_urls?.spotify || null,
      image: ep.images?.[0]?.url || null,
      duration_ms: ep.duration_ms
    }));

    res.json({ episodes });
  } catch (err) {
    console.error(
      'Feil ved henting av Spotify-episoder:',
      err?.response?.data || err
    );
    res.status(500).json({ error: 'Kunne ikke hente episoder' });
  }
});

// ---------- Spotify + KI: analyser én episode og lag reiseforslag ----------

app.post('/api/grenselos/episodes/:id/analyze', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body || {};

    if (!name || !description) {
      return res
        .status(400)
        .json({ error: 'Mangler name og description i body.' });
    }

    const aiTrip = await generateTripFromEpisode({
      episodeId: id,
      name,
      description
    });

    // Vi lagrer ikke i DB her – bare returnerer forslag
    const title = aiTrip.title || `Reise inspirert av "${name}"`;
    const descriptionText =
      aiTrip.description ||
      'Forslag til reise inspirert av en Grenseløs-episode.';
    const stops = Array.isArray(aiTrip.stops) ? aiTrip.stops : [];

    res.json({
      trip: {
        title,
        description: descriptionText,
        stops,
        stops_count: stops.length
      }
    });
  } catch (err) {
    console.error('/api/grenselos/episodes/:id/analyze-feil:', err);
    res.status(500).json({
      error:
        err.message ||
        'Kunne ikke analysere episoden og lage reiseforslag.'
    });
  }
});

// ---------- Global feilhandler ----------

app.use((err, req, res, next) => {
  console.error('Uventet feil:', err);
  res.status(500).json({ error: 'Uventet serverfeil.' });
});

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`Grenseløs Reise backend kjører på http://localhost:${PORT}`);
});
