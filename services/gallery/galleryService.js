// backend/services/gallery/galleryService.js (ESM)

import { getOpenAI } from "../openai/openaiClient.js";

// Node 18+ har global fetch. For eldre Node: fallback til node-fetch.
async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

// -------------------------------------------------------
//  UNSPLASH: hent 1 bilde fra query
// -------------------------------------------------------
async function unsplashSearchOne(queryText, { orientation = "landscape" } = {}) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null; // ikke kast; vi faller tilbake til generisk galleri

  const q = String(queryText || "").trim();
  if (!q) return null;

  const url =
    "https://api.unsplash.com/search/photos?" +
    new URLSearchParams({
      query: q,
      per_page: "1",
      orientation,
    }).toString();

  const _fetch = await getFetch();
  const r = await _fetch(url, {
    headers: { Authorization: `Client-ID ${key}` },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.warn("Unsplash search feilet:", r.status, txt.slice(0, 200));
    return null;
  }

  const data = await r.json().catch(() => null);
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
      photoUrl: photo.links?.html || null,
    },
  };
}

function safeJsonParseMaybeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function buildStopContext(stopsRaw) {
  const stops = safeJsonParseMaybeArray(stopsRaw);

  return stops
    .map((s) => {
      const name = s?.name ? String(s.name).trim() : "";
      const desc = s?.description ? String(s.description).trim() : "";
      return { name, desc };
    })
    .filter((x) => x.name);
}

// -------------------------------------------------------
//  GENERISKE BILDER FOR VIRTUELL REISE (TRYGG BACKUP)
// -------------------------------------------------------
const GENERIC_VIRTUAL_TRIP_IMAGES = [
  {
    url: "https://picsum.photos/seed/grenselos1/1200/800",
    title: "Utsikt over fjell og dal",
    caption: "Illustrasjonsfoto – generisk reisebilde.",
  },
  {
    url: "https://picsum.photos/seed/grenselos2/1200/800",
    title: "Kystlinje og hav",
    caption: "Illustrasjonsfoto – inspirasjon til kystreiser.",
  },
  {
    url: "https://picsum.photos/seed/grenselos3/1200/800",
    title: "Bygate på kveldstid",
    caption: "Illustrasjonsfoto – storbyfølelse.",
  },
  {
    url: "https://picsum.photos/seed/grenselos4/1200/800",
    title: "Små vei og åpent landskap",
    caption: "Illustrasjonsfoto – roadtrip-stemning.",
  },
];

export function getGenericVirtualTripGallery(count = 3) {
  if (!Array.isArray(GENERIC_VIRTUAL_TRIP_IMAGES) || GENERIC_VIRTUAL_TRIP_IMAGES.length === 0) {
    return [];
  }

  const n = Math.max(1, Math.min(Number(count) || 3, GENERIC_VIRTUAL_TRIP_IMAGES.length));
  const shuffled = [...GENERIC_VIRTUAL_TRIP_IMAGES].sort(() => Math.random() - 0.5);

  return shuffled.slice(0, n).map((item, idx) => ({
    url: item.url,
    title: item.title || "Reisebilde",
    caption: item.caption || "Illustrasjonsfoto",
    source: "fallback",
    stopIndex: idx,
    attribution: null,
  }));
}

/**
 * KI-basert galleri for "fra scratch"-reiser
 * Forsøker å hente 3–8 bilder som matcher destinasjon/stemning
 */
export async function generateGalleryForTrip(title, description, stopsRaw) {
  try {
    const openai = getOpenAI();
    const stops = buildStopContext(stopsRaw);

    // Hvis vi ikke har noe å jobbe med, bruk fallback
    if (!stops.length && !String(title || "").trim()) {
      return getGenericVirtualTripGallery(3);
    }

    // 1) KI lager queries (ikke URL)
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
- Maks 8 elementer.
- Hvis det finnes stopp: prøv å gi ca. 1 per stopp (stopIndex refererer til rekkefølgen i stopp-lista).
- query må være konkret og inneholde sted + land/region + motiv.
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
        { role: "user", content: context },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    });

    const content = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("❌ JSON parse-feil i generateGalleryForTrip:", e);
      return getGenericVirtualTripGallery(3);
    }

    const raw = Array.isArray(parsed?.gallery) ? parsed.gallery : [];
    const wanted = raw
      .map((x) => {
        const query = typeof x?.query === "string" ? x.query.trim() : "";
        const stopIndex = Number.isInteger(x?.stopIndex) ? x.stopIndex : null;

        // stopIndex kan være null hvis modellen ikke følger formatet; da kan vi sette 0
        const idx = stopIndex == null ? 0 : stopIndex;

        if (!query) return null;

        return {
          query,
          title: (typeof x?.title === "string" && x.title.trim()) || null,
          caption: (typeof x?.caption === "string" && x.caption.trim()) || null,
          stopIndex: idx,
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    if (!wanted.length) return getGenericVirtualTripGallery(3);

    // 2) Backend henter ekte bilder fra Unsplash (1 per query)
    const out = [];
    const seenUrls = new Set();

    for (const item of wanted) {
      const stop = stops[item.stopIndex] || null;

      const fallbackQuery = stop?.name
        ? `${stop.name} travel photo`
        : `${title || "travel"} travel photo`;

      const q = item.query || fallbackQuery;

      const hit = await unsplashSearchOne(q);
      if (!hit?.url) continue;

      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);

      out.push({
        url: hit.url,
        title: item.title || stop?.name || title || "Reisebilde",
        caption: item.caption || stop?.desc || null,

        source: hit.source,
        attribution: hit.unsplash
          ? {
              provider: "Unsplash",
              photographer: hit.unsplash.photographer,
              photographerUrl: hit.unsplash.photographerUrl,
              photoUrl: hit.unsplash.photoUrl,
            }
          : null,

        stopIndex: item.stopIndex,
      });
    }

    // Hvis Unsplash ikke ga noe (key mangler eller tomt)
    if (!out.length) return getGenericVirtualTripGallery(3);

    // Begrens til 8 og returner
    return out.slice(0, 8);
  } catch (e) {
    console.error("❌ generateGalleryForTrip-feil:", e);
    return getGenericVirtualTripGallery(3);
  }
}
