// -------------------------------------------------------
//  GENERISKE BILDER FOR VIRTUELL REISE (IKKE-EPISODE-TRIPS)
// -------------------------------------------------------

// En liten liste med generiske reisebilder (fri bruk via picsum.photos)
// Disse ligger EKSTERN på nett og trenger ikke å lastes opp i backend.
const GENERIC_VIRTUAL_TRIP_IMAGES = [
  {
    url: "https://picsum.photos/seed/grenselos1/1200/800",
    title: "Utsikt over fjell og dal",
    caption: "Illustrasjonsfoto – generisk reisebilde."
  },
  {
    url: "https://picsum.photos/seed/grenselos2/1200/800",
    title: "Kystlinje og hav",
    caption: "Illustrasjonsfoto – inspirasjon til kystreiser."
  },
  {
    url: "https://picsum.photos/seed/grenselos3/1200/800",
    title: "Bygate på kveldstid",
    caption: "Illustrasjonsfoto – storbyfølelse."
  },
  {
    url: "https://picsum.photos/seed/grenselos4/1200/800",
    title: "Små vei og åpent landskap",
    caption: "Illustrasjonsfoto – roadtrip-stemning."
  }
];



// -------------------------------------------------------
//  GENERISK FALLBACK-GALLERI (TRYGG BACKUP)
// -------------------------------------------------------
function getGenericVirtualTripGallery(count = 3) {
  if (
    !Array.isArray(GENERIC_VIRTUAL_TRIP_IMAGES) ||
    GENERIC_VIRTUAL_TRIP_IMAGES.length === 0
  ) {
    return [];
  }

  // Shuffle uten å mutere originalen
  const shuffled = [...GENERIC_VIRTUAL_TRIP_IMAGES].sort(
    () => Math.random() - 0.5
  );

  return shuffled
    .slice(0, Math.min(count, GENERIC_VIRTUAL_TRIP_IMAGES.length))
    .map((item, idx) => ({
      url: item.url,
      title: item.title || "Reisebilde",
      caption: item.caption || "Illustrasjonsfoto",
      source: "fallback",        // 👈 viktig
      stopIndex: idx,             // 👈 stabil rekkefølge
      attribution: null
    }));
}

// Hent gode søkeord fra stopp + tittel/beskrivelse
function buildLocationQueriesFromStops(stops, tripTitle = "", tripDescription = "") {
  const queries = [];
  const seen = new Set();

  const pushUnique = (q) => {
    if (!q) return;
    const trimmed = q.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };

  const arrStops = Array.isArray(stops) ? stops : [];

  // 1) Navn / city / country fra stopp
  for (const s of arrStops) {
    const name = s?.name;
    const city = s?.city;
    const country = s?.country;

    if (city && country) {
      pushUnique(`${city}, ${country}`);
      pushUnique(`${city} ${country} travel`);
    } else if (city) {
      pushUnique(`${city} travel`);
    } else if (name) {
      const first = String(name).split(",")[0];
      if (first.length > 2) {
        pushUnique(first);
        pushUnique(`${first} travel`);
      }
    }

    if (queries.length >= 4) break;
  }

  // 2) Fyll på fra tittel/beskrivelse hvis få queries
  if (queries.length < 3) {
    const base = `${tripTitle} ${tripDescription}`.trim();
    if (base) {
      const words = base
        .split(/[\s,–\-:]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 3);
      for (const w of words) {
        pushUnique(w);
        if (queries.length >= 6) break;
      }
    }
  }

  // 3) Utvid med travel/landscape-varianter
  const expanded = [];
  const seen2 = new Set();
  for (const q of queries) {
    const variants = [q, `${q} travel`, `${q} landscape`];
    for (const v of variants) {
      const key = v.toLowerCase();
      if (seen2.has(key)) continue;
      seen2.add(key);
      expanded.push(v);
    }
  }

  return expanded.slice(0, 6);
}

function sanitizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;

  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const lower = withProto.toLowerCase();

  if (
    lower.includes("example.com") ||
    lower.includes("example.org") ||
    lower.includes("example.net")
  ) return null;

  // Enkel URL-validering
  try {
    new URL(withProto);
    return withProto;
  } catch {
    return null;
  }
}

// -------------------------------------------------------
//  KI-basert galleri for "fra scratch"-reiser
//  Forsøker å hente 5–8 bilder som matcher destinasjon/stemning
// -------------------------------------------------------

async function unsplashSearchOne(queryText, { orientation = "landscape" } = {}) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error("Mangler UNSPLASH_ACCESS_KEY");

  const q = String(queryText || "").trim();
  if (!q) return null;

  const url =
    "https://api.unsplash.com/search/photos?" +
    new URLSearchParams({
      query: q,
      per_page: "1",
      orientation
    }).toString();

  const r = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}` }
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.warn("Unsplash search feilet:", r.status, txt.slice(0, 200));
    return null;
  }

  const data = await r.json();
  const photo = data?.results?.[0];
  if (!photo?.urls?.raw) return null;

  // Stabil bilde-URL (raw + params)
  const imageUrl =
    photo.urls.raw +
    (photo.urls.raw.includes("?") ? "&" : "?") +
    "auto=format&fit=crop&w=1600&q=80";

  return {
    url: imageUrl,
    source: "unsplash",
    unsplash: {
      id: photo.id,
      photographer: photo.user?.name || null,
      photographerUrl: photo.user?.links?.html || null,
      photoUrl: photo.links?.html || null
    }
  };
}

async function generateGalleryForTrip(title, description, stopsRaw) {
  try {
    const stops = buildStopContext(stopsRaw);

    // 1) KI lager "query" per bilde, ikke URL
    const systemPrompt = `
Du lager søkestrenger (queries) for å finne gode reisebilder.
Du MÅ svare med REN JSON.

Format:
{
  "gallery": [
    {
      "query": "sted + land/region + motiv (f.eks. beach/old town/mountain)",
      "title": "Kort tittel",
      "caption": "Kort bildetekst",
      "stopIndex": 0
    }
  ]
}

KRAV:
- 1 element per stopp (stopIndex refererer til rekkefølgen i stopp-lista).
- query må være konkret og inneholde sted + land/region + motiv.
- Maks 8 elementer.
- Ingen URLer, kun query.
`.trim();

    const context = `
Tittel: ${title || ""}
Beskrivelse: ${description || ""}

Stopp:
${stops.map((s, i) => `#${i} ${s.name}\n${s.desc || ""}`).join("\n\n")}
`.trim();

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: context }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("❌ JSON parse-feil i generateGalleryForTrip:", e, content);
      return getGenericVirtualTripGallery(3);
    }

    const raw = Array.isArray(parsed.gallery) ? parsed.gallery : [];
    const wanted = raw
      .map((x) => {
        const query = typeof x?.query === "string" ? x.query.trim() : "";
        const stopIndex = Number.isInteger(x?.stopIndex) ? x.stopIndex : null;
        if (!query || stopIndex === null) return null;

        return {
          query,
          title: (typeof x?.title === "string" && x.title.trim()) || null,
          caption: (typeof x?.caption === "string" && x.caption.trim()) || null,
          stopIndex
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    if (!wanted.length) return getGenericVirtualTripGallery(3);

    // 2) Backend henter ekte bilder fra Unsplash (1 per query)
    const out = [];
    for (const item of wanted) {
      const stop = stops[item.stopIndex];
      const fallbackQuery = stop?.name
        ? `${stop.name} ${title || ""} travel photo`
        : `${title || "travel"} travel photo`;

      const q = item.query || fallbackQuery;

      const hit = await unsplashSearchOne(q);
      if (!hit) continue;

      out.push({
        url: hit.url,
        title: item.title || stop?.name || title || "Reisebilde",
        caption: item.caption || stop?.desc || null,

        // valgfritt metadata
        source: hit.source,
        attribution: hit.unsplash
          ? {
              provider: "Unsplash",
              photographer: hit.unsplash.photographer,
              photographerUrl: hit.unsplash.photographerUrl,
              photoUrl: hit.unsplash.photoUrl
            }
          : null,

        stopIndex: item.stopIndex
      });
    }

    // Hvis Unsplash ikke ga noe (key mangler eller tomt)
    if (!out.length) return getGenericVirtualTripGallery(3);

    return out;
  } catch (e) {
    console.error("❌ generateGalleryForTrip-feil:", e);
    return getGenericVirtualTripGallery(3);
  }
}

function makeHotelFallbackUrl(h) {
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(location ? `${name} ${location} hotell` : `${name} hotell`);
  return `https://www.google.com/search?q=${q}`;
}

function makeExperienceFallbackUrl(x) {
  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();
  if (!name) return null;
  const q = encodeURIComponent(location ? `${name} ${location} billetter` : `${name} billetter`);
  return `https://www.google.com/search?q=${q}`;
}

async function getUserEntitlements(userId) {
  const r = await query(`SELECT is_premium, is_admin FROM users WHERE id=$1`, [userId]);
  const u = r.rows?.[0] || {};
  return { isPro: !!(u.is_premium || u.is_admin), is_admin: !!u.is_admin, is_premium: !!u.is_premium };
}

function requirePro(req, res, next) {
  if (req.user?.is_admin || req.user?.is_premium) return next();
  return res.status(402).json({ error: "Krever Pro/Premium for tilgang." });
}

// Bruk søk-fallback (ikke Maps) hvis ingen eksplisitt URL finnes
function makeHotelUrl(h) {
  // 1) Direkte URL-felter
  const direct =
    sanitizeUrl(h?.url) ||
    sanitizeUrl(h?.booking_url) ||
    sanitizeUrl(h?.link) ||
    sanitizeUrl(h?.external_url);

  if (direct) return direct;

  // 2) Fallback: Google-søk (bedre enn maps for hoteller)
  const name = (h?.name || h?.title || "").toString().trim();
  const location = (h?.location || h?.city || h?.area || "").toString().trim();

  if (!name) return null;

  const q = encodeURIComponent(
    location ? `${name} ${location} hotell` : `${name} hotell`
  );

  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(
    location ? `${name} ${location}` : name
  )}`;
}

function makeExperienceUrl(x) {
  // 1) Prøv eksplisitte URL-felt
  const direct =
    sanitizeUrl(x?.url) ||
    sanitizeUrl(x?.booking_url) ||
    sanitizeUrl(x?.ticket_url) ||
    sanitizeUrl(x?.link) ||
    sanitizeUrl(x?.external_url);

  if (direct) return direct;

  // 2) Fallback: Google-søk på billetter
  const name = (x?.name || x?.title || "").toString().trim();
  const location = (x?.location || x?.city || x?.area || "").toString().trim();

  if (!name) return null;

  const q = encodeURIComponent(
    location ? `${name} ${location} billetter` : `${name} billetter`
  );

  return `https://www.google.com/search?q=${q}`;
}
