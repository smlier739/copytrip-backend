// backend/services/urls/urlHelpers.js (ESM)

// ------------------ small helpers ------------------
function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

export function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  return /^https?:\/\/\S+/i.test(s.trim());
}

function buildGoogleSearchUrl(query) {
  const q = safeStr(query);
  if (!q) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// ------------------ sanitizeUrl ------------------
export function sanitizeUrl(u) {
  const s = safeStr(u);
  if (!s) return null;

  // Hvis noen sender inn "example.com" -> legg på https://
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;

  // Blokker åpenbart farlige schemes (i tilfelle input allerede har scheme)
  const lower = withProto.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:") ||
    lower.startsWith("ftp:")
  ) {
    return null;
  }

  // Blokker placeholder-domener
  if (
    lower.includes("example.com") ||
    lower.includes("example.org") ||
    lower.includes("example.net")
  ) {
    return null;
  }

  try {
    const url = new URL(withProto);

    // Kun http/https
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    // Må ha host
    if (!url.hostname) return null;

    // Normaliser bort trailing spaces etc.
    return url.toString();
  } catch {
    return null;
  }
}

// ------------------ fallback URL builders ------------------
// NB: Bevisst Google SEARCH (ikke Google Maps) for å følge policyen din.

export function makeHotelFallbackUrl(h) {
  const name = safeStr(h?.name || h?.title);
  const location = safeStr(h?.location || h?.city || h?.area);
  if (!name) return null;

  const q = location ? `${name} ${location} hotell` : `${name} hotell`;
  return buildGoogleSearchUrl(q);
}

export function makeExperienceFallbackUrl(x) {
  const name = safeStr(x?.name || x?.title);
  const location = safeStr(x?.location || x?.city || x?.area);
  if (!name) return null;

  const q = location ? `${name} ${location} billetter` : `${name} billetter`;
  return buildGoogleSearchUrl(q);
}

// Generic fallback for "place" (også uten maps)
export function makeFallbackPlaceUrl(name, location) {
  const n = safeStr(name);
  const loc = safeStr(location);
  if (!n) return null;

  const q = loc ? `${n} ${loc}` : n;
  return buildGoogleSearchUrl(q);
}

// ------------------ query builder for gallery / geocoding contexts ------------------
export function buildLocationQueriesFromStops(stops, tripTitle = "", tripDescription = "") {
  const queries = [];
  const seen = new Set();

  const pushUnique = (q) => {
    const t = safeStr(q);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(t);
  };

  const arrStops = Array.isArray(stops) ? stops : [];

  // 1) Fra stopp
  for (const s of arrStops) {
    const name = safeStr(s?.name);
    const city = safeStr(s?.city);
    const country = safeStr(s?.country);

    if (city && country) {
      pushUnique(`${city}, ${country}`);
      pushUnique(`${city} ${country} travel`);
    } else if (city) {
      pushUnique(`${city} travel`);
    } else if (name) {
      const first = name.split(",")[0].trim();
      if (first.length > 2) {
        pushUnique(first);
        pushUnique(`${first} travel`);
      }
    }

    if (queries.length >= 4) break;
  }

  // 2) Fyll på fra tittel/beskrivelse hvis få
  if (queries.length < 3) {
    const base = safeStr(`${tripTitle} ${tripDescription}`);
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

  // 3) Utvid varianter
  const expanded = [];
  const seen2 = new Set();

  for (const q of queries) {
    for (const v of [q, `${q} travel`, `${q} landscape`]) {
      const key = v.toLowerCase();
      if (seen2.has(key)) continue;
      seen2.add(key);
      expanded.push(v);
    }
  }

  return expanded.slice(0, 6);
}

/*
  VIKTIG:
  - Fjern/ikke ha app.use((req,res,next)=>...) her. Legg request-logging i server entrypoint (index.js/app.js).
*/
