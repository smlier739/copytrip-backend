function normalizePackingToFourCategoriesSmart(rawPacking, tripContextText = "") {
  // -------- helpers --------
  const normalizeStr = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[-•\d\)\.]+\s*/, ""); // fjerner bullet/nummering

  const splitToItems = (s) =>
    String(s || "")
      .split(/[\n,]/)
      .map((x) => normalizeStr(x))
      .filter(Boolean);

  // 1) Flat ut til ren liste strings
  let items = [];

  const pushItem = (s) => {
    const t = normalizeStr(s);
    if (!t) return;
    items.push(t);
  };

  if (typeof rawPacking === "string") {
    // JSON-string eller vanlig tekst
    try {
      return normalizePackingToFourCategoriesSmart(JSON.parse(rawPacking), tripContextText);
    } catch {
      splitToItems(rawPacking).forEach(pushItem);
    }
  } else if (Array.isArray(rawPacking)) {
    for (const g of rawPacking) {
      if (typeof g === "string") {
        pushItem(g);
      } else if (g && typeof g === "object") {
        if (Array.isArray(g.items)) g.items.forEach(pushItem);
        else if (typeof g.items === "string") splitToItems(g.items).forEach(pushItem);
      }
    }
  } else if (rawPacking && typeof rawPacking === "object") {
    for (const val of Object.values(rawPacking)) {
      if (Array.isArray(val)) val.forEach(pushItem);
      else if (typeof val === "string") splitToItems(val).forEach(pushItem);
    }
  }

  // dedupe (case-insensitive)
  const seen = new Set();
  items = items.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 2) Kontekst (varmt/kaldt/strand/tur/regn osv.)
  const ctx = (tripContextText || "").toLowerCase();
  const isBeach = /strand|bade|snorkl|dykk|kyst|hav|surf/.test(ctx);
  const isHike = /tur|fottur|fjell|trek|stier|vandring/.test(ctx);
  const isRainy = /regn|monsun|tropisk|våt|skurer/.test(ctx);
  const isCold  = /kald|vinter|snø|frost|sibir|arktisk/.test(ctx);
  const isHot   = /varm|hete|tropisk|sol|sør|ørken/.test(ctx);

  // 3) Klassifisering med litt mer presisjon + prioritet
  const buckets = { "Klær": [], "Toalettsaker": [], "Elektronikk": [], "Annet": [] };

  const hasAny = (t, words) => words.some((w) => t.includes(w));

  const isElectronics = (t) =>
    hasAny(t, [
      "lader","kabel","adapter","powerbank","mobil","telefon","iphone","android",
      "kamera","gopro","drone","hodetelefon","airpods","pc","laptop","mac","ipad",
      "nettbrett","minnekort","batteri","usb","strøm"
    ]);

  const isToiletries = (t) =>
    hasAny(t, [
      "tannbørste","tannkrem","tann","deodor","sjampo","shampoo","balsam","såpe",
      "hudkrem","fukt","barber","sminke","linser","kontaktlinser","medisin",
      "plaster","førstehjelp","mygg","insekt","hånddesinf","solkrem","after sun"
    ]);

  const isClothes = (t) =>
    hasAny(t, [
      "t-skjorte","skjorte","genser","bukse","shorts","undertøy","sok","jakke",
      "regnjakke","vindjakke","sko","joggesko","fjellsko","sandaler",
      "caps","hatt","lue","votter","buff","badetøy","bikini","badebukse"
    ]);

  const isDocsMoney = (t) =>
    hasAny(t, ["pass","id","førerkort","reiseforsikring","forsikring","kontanter","kort","visa"]);

  const isGear = (t) =>
    hasAny(t, [
      "dagstursekk","ryggsekk","sekk","vannflaske","drikkeflaske","hodelykt",
      "kniv","multiverktøy","kart","kompass","pakkpose","vanntett pose","poncho",
      "myggnett","telt","sovepose"
    ]);

  // 3b) “Tvetydige” items justeres av kontekst
  // - solkrem: Toalettsaker (alltid)
  // - badetøy: Klær (men bare hvis strand/varmt, ellers nedprioriter)
  // - fottøy for fotturer: Klær
  // - regnjakke/poncho: Klær/Annet (vi velger Klær)
  // - kamera: Elektronikk (alltid)
  // - førstehjelp: Toalettsaker

  for (const item of items) {
    const t = item.toLowerCase();

    // Prioritet: Dokumenter/”må-ha” -> Annet
    if (isDocsMoney(t)) {
      buckets["Annet"].push(item);
      continue;
    }

    // Elektronikk
    if (isElectronics(t)) {
      buckets["Elektronikk"].push(item);
      continue;
    }

    // Toalettsaker
    if (isToiletries(t)) {
      buckets["Toalettsaker"].push(item);
      continue;
    }

    // Klær
    if (isClothes(t)) {
      // Hvis “badetøy” men reisen ikke virker strand/varm -> putt i Annet (valgfritt)
      if (hasAny(t, ["badetøy","bikini","badebukse"]) && !(isBeach || isHot)) {
        buckets["Annet"].push(item);
      } else {
        buckets["Klær"].push(item);
      }
      continue;
    }

    // Utstyr/gear
    if (isGear(t)) {
      // tur/trek -> ofte “Annet”
      buckets["Annet"].push(item);
      continue;
    }

    // fallback
    buckets["Annet"].push(item);
  }

  // 4) Kontekstbaserte “must-have” dersom mangler
  const defaults = {
    "Klær": ["Undertøy", "Sokker", "T-skjorter"],
    "Toalettsaker": ["Tannbørste", "Tannkrem", "Deodorant"],
    "Elektronikk": ["Mobil + lader", "Powerbank", "Hodetelefoner"],
    "Annet": ["Pass/ID-kort", "Reiseforsikring", "Liten dagstursekk"]
  };

  if (isRainy) {
    defaults["Klær"].unshift("Regnjakke");
    defaults["Annet"].unshift("Vanntett pakkpose");
  }
  if (isCold) {
    defaults["Klær"].unshift("Ullundertøy", "Lue og votter");
  }
  if (isBeach || isHot) {
    defaults["Klær"].unshift("Badetøy");
    defaults["Toalettsaker"].unshift("Solkrem");
  }
  if (isHike) {
    defaults["Klær"].unshift("Gode tursko");
    defaults["Annet"].unshift("Vannflaske");
  }

  for (const cat of ["Klær", "Toalettsaker", "Elektronikk", "Annet"]) {
    while (buckets[cat].length < 3) {
      const candidate = defaults[cat][buckets[cat].length] || null;
      if (!candidate) break;
      if (!buckets[cat].some((x) => x.toLowerCase() === candidate.toLowerCase())) {
        buckets[cat].push(candidate);
      } else {
        break;
      }
    }
  }

  // 5) return nøyaktig 4 kategorier i riktig rekkefølge (maks 10 items per kategori)
  return [
    { category: "Klær",        items: buckets["Klær"].slice(0, 10) },
    { category: "Toalettsaker",items: buckets["Toalettsaker"].slice(0, 10) },
    { category: "Elektronikk", items: buckets["Elektronikk"].slice(0, 10) },
    { category: "Annet",       items: buckets["Annet"].slice(0, 10) }
  ];
}

// ---------- helpers: JSON + URL ----------
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
  // pg JSONB kan komme som object i enkelte tilfeller – bare avvis alt som ikke er array
  return [];
};

const isHttpUrl = (s) => {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^https?:\/\/\S+/i.test(t);
};

const makeFallbackPlaceUrl = (name, location) => {
  const n = (name || "").toString().trim();
  const loc = (location || "").toString().trim();
  if (!n) return null;
  const q = encodeURIComponent(loc ? `${n} ${loc}` : n);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
};

// Normaliser experiences til { name, description, location, url, day, price }
const normalizeExperiences = (raw) => {
  const arr = parseJsonArray(raw);

  return arr
    .filter((x) => x && typeof x === "object")
    .map((x, i) => {
      const name =
        (x.name || x.title || x.activity || "").toString().trim() ||
        `Opplevelse ${i + 1}`;

      const description = (x.description || "").toString().trim();
      const location = (x.location || x.city || x.area || "").toString().trim();

      const rawUrl =
        (typeof x.url === "string" && x.url.trim()) ||
        (typeof x.booking_url === "string" && x.booking_url.trim()) ||
        (typeof x.ticket_url === "string" && x.ticket_url.trim()) ||
        (typeof x.link === "string" && x.link.trim()) ||
        (typeof x.external_url === "string" && x.external_url.trim()) ||
        null;

      const url = rawUrl ? (isHttpUrl(rawUrl) ? rawUrl.trim() : null) : makeFallbackPlaceUrl(name, location);

      const day = typeof x.day === "number" ? x.day : null;
      const price = typeof x.price === "number" ? x.price : null;

      return {
        id: x.id ?? `exp-${i}`,
        name,
        description,
        location,
        url,
        day,
        price
      };
    })
    .filter((e) => e.name);
};

// Helper for å normalisere pakkeliste-struktur
function normalizePackingForClient(rawPacking) {
  if (!rawPacking) return [];

  // Hvis JSON-string → parse
  if (typeof rawPacking === "string") {
    try {
      return normalizePackingForClient(JSON.parse(rawPacking));
    } catch {
      return [];
    }
  }

  // Hvis objekt: { "Klær": ["T-skjorte", ...] }
  if (!Array.isArray(rawPacking) && typeof rawPacking === "object") {
    const groups = [];
    for (const [key, value] of Object.entries(rawPacking)) {
      const category = key?.trim() || "Annet";

      let items = value;
      if (typeof items === "string") {
        items = items.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      }
      if (!Array.isArray(items)) items = [];

      items = items.map((x) => x.trim()).filter(Boolean);

      if (items.length) {
        groups.push({ category, items });
      }
    }
    return groups;
  }

  // Hvis array
  if (Array.isArray(rawPacking)) {
    // Streng-liste → én gruppe
    if (rawPacking.length && typeof rawPacking[0] === "string") {
      const items = rawPacking
        .map((x) => x.trim())
        .filter(Boolean);
      return items.length ? [{ category: "Annet", items }] : [];
    }

    // Gruppe-liste
    return rawPacking
      .map((group) => {
        if (typeof group === "string") {
          return { category: "Annet", items: [group.trim()] };
        }
        if (!group || typeof group !== "object") {
          return { category: "Annet", items: [] };
        }

        const category = group.category?.trim() || "Annet";

        let items = group.items;
        if (typeof items === "string") {
          items = items.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
        }
        if (!Array.isArray(items)) items = [];

        items = items.map((x) => x.trim()).filter(Boolean);

        return { category, items };
      })
      .filter((g) => g.items.length > 0);
  }

  return [];
}

function buildStopContext(stopsRaw) {
  let stops = stopsRaw;

  if (typeof stops === "string") {
    try { stops = JSON.parse(stops); } catch { stops = []; }
  }

  if (!Array.isArray(stops)) stops = [];

  return stops
    .map((s) => {
      const name = s?.name ? String(s.name).trim() : "";
      const desc = s?.description ? String(s.description).trim() : "";
      return { name, desc };
    })
    .filter((x) => x.name);
}

function normalizeTripStructure(parsed) {
  // -------------------------
  // Helpers
  // -------------------------
  const safeStr = (v) =>
    typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();

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

  const parseArrayField = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const p = JSON.parse(value);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  // Booking/ticket fallback (IKKE maps)
  const makeTicketSearchUrl = (title, location) => {
    const t = safeStr(title);
    const loc = safeStr(location);
    if (!t) return null;
    const q = encodeURIComponent(loc ? `${t} ${loc} billetter` : `${t} billetter`);
    return `https://www.google.com/search?q=${q}`;
  };

  // -------------------------
  // Guard
  // -------------------------
  if (!parsed || typeof parsed !== "object") {
    return {
      title: "Reiseforslag fra KI",
      description: null,
      stops: [],
      packing_list: normalizePackingToFourCategoriesSmart([], ""),
      hotels: [],
      experiences: []
    };
  }

  // -------------------------
  // Title / description
  // -------------------------
  const title = safeStr(parsed.title) || "Reiseforslag fra KI";
  const description = safeStr(parsed.description) || null;

  // -------------------------
  // STOPS
  // -------------------------
  const rawStops = parseArrayField(parsed.stops);

  const stops = rawStops
    .filter((s) => s && typeof s === "object")
    .map((s, idx) => {
      const name = safeStr(s.name || s.title) || `Stopp ${idx + 1}`;
      const desc = safeStr(s.description) || "";

      const lat = toNumOrNull(s.lat ?? s.latitude);
      const lng = toNumOrNull(s.lng ?? s.longitude);

      let day = s.day ?? null;
      day = typeof day === "number" ? day : toNumOrNull(day);
      if (day == null) day = idx + 1;

      const location = safeStr(s.location || s.address || s.subtitle) || null;

      // Hotels pr stop (valgfritt)
      const stopHotels = parseArrayField(s.hotels)
        .filter((h) => h && typeof h === "object")
        .map((h, hi) => {
          const hn = safeStr(h.name || h.title) || `Hotell ${hi + 1}`;
          const hl = safeStr(h.location || h.area || h.city) || null;
          const hd = safeStr(h.description || h.notes) || "";
          const price =
            typeof h.price_per_night === "number"
              ? h.price_per_night
              : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

          const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
          const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

          return { name: hn, location: hl, description: hd, price_per_night: price, url };
        })
        .filter((h) => safeStr(h.name));

      return {
        id: s.id ?? `s-${idx}`,
        day,
        name,
        description: desc,
        location,
        lat,
        lng,
        hotels: stopHotels
      };
    })
    .filter((s) => safeStr(s.name));

  // -------------------------
  // PACKING LIST -> NØYAKTIG 4 kategorier (smart)
  // -------------------------
  const rawPacking =
    parsed.packing_list ||
    parsed.packingList ||
    parsed.packing ||
    [];

  const contextText =
    `${title}\n${description || ""}\n` +
    stops.map((s) => `${safeStr(s.name)} ${safeStr(s.description)}`).join("\n");

  const packing_list = normalizePackingToFourCategoriesSmart(rawPacking, contextText);

  // -------------------------
  // HOTELS (flat) + inkluder evt. hotels fra stops
  // -------------------------
  const rawHotelsCombined = [
    ...(Array.isArray(parsed.hotels) ? parsed.hotels : parseArrayField(parsed.hotels)),
    ...stops.flatMap((s) => (Array.isArray(s.hotels) ? s.hotels : []))
  ];

  const hotels = rawHotelsCombined
    .filter((h) => h && typeof h === "object")
    .map((h, idx) => {
      const name = safeStr(h.name || h.title) || `Hotell ${idx + 1}`;
      const location = safeStr(h.location || h.area || h.city) || null;
      const descriptionH = safeStr(h.description || h.notes) || "";

      const price =
        typeof h.price_per_night === "number"
          ? h.price_per_night
          : toNumOrNull(h.price_per_night ?? h.approx_price_per_night);

      const rawUrl = safeStr(h.url || h.booking_url || h.link || h.external_url) || null;
      const url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;

      return {
        id: h.id ?? `h-${idx}`,
        name,
        location,
        description: descriptionH,
        price_per_night: price ?? null,
        url
      };
    })
    .filter((h) => safeStr(h.name));

  // -------------------------
  // EXPERIENCES (ny!)
  // -------------------------
  const rawExperiences =
    parseArrayField(parsed.experiences).length
      ? parseArrayField(parsed.experiences)
      : parseArrayField(parsed.activities || parsed.tickets || parsed.bookings);

  const experiences = rawExperiences
    .filter((x) => x && typeof x === "object")
    .map((x, idx) => {
      const name = safeStr(x.title || x.name || x.activity) || `Opplevelse ${idx + 1}`;
      const location = safeStr(x.location || x.city || x.area) || null;
      const descriptionX = safeStr(x.description) || "";

      const rawUrl = safeStr(
        x.booking_url || x.url || x.ticket_url || x.link || x.external_url
      ) || null;

      const url = rawUrl
        ? (isHttpUrl(rawUrl) ? rawUrl : null)
        : makeTicketSearchUrl(name, location);

      const day =
        typeof x.day === "number" ? x.day : toNumOrNull(x.day);

      const price_per_person =
        typeof x.price_per_person === "number"
          ? x.price_per_person
          : toNumOrNull(x.price_per_person);

      const currency = safeStr(x.currency) || "NOK";

      return {
        id: x.id ?? `exp-${idx}`,
        name,
        location,
        description: descriptionX,
        url,
        day: day ?? null,
        price_per_person: price_per_person ?? null,
        currency
      };
    })
    .filter((e) => safeStr(e.name));

  return {
    title,
    description,
    stops,
    packing_list,
    hotels,
    experiences
  };
}


// backend/src/utils/tripNormalize.js
export function normalizePackingToFourCategoriesSmart(...) { ... }
export const parseJsonArray = (...) => { ... }
export const isHttpUrl = (...) => { ... }
export const makeFallbackPlaceUrl = (...) => { ... }
export const normalizeExperiences = (...) => { ... }
