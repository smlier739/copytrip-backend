// backend/services/packing/normalizePackingToFourCategoriesSmart.js (ESM)

export function normalizePackingToFourCategoriesSmart(rawPacking, tripContextText = "") {
  // -------- helpers --------
  const normalizeStr = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[-•\d\)\.]+\s*/, "")      // fjerner bullet/nummering
      .replace(/[;:.\-–—]+$/, "")         // fjerner trailing tegn
      .trim();

  const shouldDropItem = (s) => {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return true;
    if (t.length < 2) return true;
    return ["osv", "diverse", "annet", "ting", "greier"].includes(t);
  };

  const splitToItems = (s) =>
    String(s || "")
      .split(/[\n,]/)
      .map((x) => normalizeStr(x))
      .filter((x) => !shouldDropItem(x));

  // 1) Flat ut til ren liste strings
  let items = [];

  const pushItem = (s) => {
    const t = normalizeStr(s);
    if (shouldDropItem(t)) return;
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
  const isCold = /kald|vinter|snø|frost|sibir|arktisk/.test(ctx);
  const isHot = /varm|hete|tropisk|sol|sør|ørken/.test(ctx);

  // 3) Klassifisering
  const buckets = { Klær: [], Toalettsaker: [], Elektronikk: [], Annet: [] };

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

  for (const item of items) {
    const t = item.toLowerCase();

    if (isDocsMoney(t)) {
      buckets.Annet.push(item);
      continue;
    }
    if (isElectronics(t)) {
      buckets.Elektronikk.push(item);
      continue;
    }
    if (isToiletries(t)) {
      buckets.Toalettsaker.push(item);
      continue;
    }
    if (isClothes(t)) {
      if (hasAny(t, ["badetøy", "bikini", "badebukse"]) && !(isBeach || isHot)) {
        buckets.Annet.push(item);
      } else {
        buckets.Klær.push(item);
      }
      continue;
    }
    if (isGear(t)) {
      buckets.Annet.push(item);
      continue;
    }

    buckets.Annet.push(item);
  }

  // 4) Kontekstbaserte defaults dersom mangler
  const defaults = {
    Klær: ["Undertøy", "Sokker", "T-skjorter"],
    Toalettsaker: ["Tannbørste", "Tannkrem", "Deodorant"],
    Elektronikk: ["Mobil + lader", "Powerbank", "Hodetelefoner"],
    Annet: ["Pass/ID-kort", "Reiseforsikring", "Liten dagstursekk"],
  };

  if (isRainy) {
    defaults.Klær = ["Regnjakke", ...defaults.Klær];
    defaults.Annet = ["Vanntett pakkpose", ...defaults.Annet];
  }
  if (isCold) {
    defaults.Klær = ["Ullundertøy", "Lue og votter", ...defaults.Klær];
  }
  if (isBeach || isHot) {
    defaults.Klær = ["Badetøy", ...defaults.Klær];
    defaults.Toalettsaker = ["Solkrem", ...defaults.Toalettsaker];
  }
  if (isHike) {
    defaults.Klær = ["Gode tursko", ...defaults.Klær];
    defaults.Annet = ["Vannflaske", ...defaults.Annet];
  }

  // Fyll opp til minst 3 – prøv videre hvis kandidat er duplikat
  for (const cat of ["Klær", "Toalettsaker", "Elektronikk", "Annet"]) {
    for (const candidate of defaults[cat]) {
      if (buckets[cat].length >= 3) break;
      const exists = buckets[cat].some((x) => x.toLowerCase() === candidate.toLowerCase());
      if (!exists) buckets[cat].push(candidate);
    }
  }

  // 5) Return nøyaktig 4 kategorier (maks 10 per kategori)
  return [
    { category: "Klær", items: buckets.Klær.slice(0, 10) },
    { category: "Toalettsaker", items: buckets.Toalettsaker.slice(0, 10) },
    { category: "Elektronikk", items: buckets.Elektronikk.slice(0, 10) },
    { category: "Annet", items: buckets.Annet.slice(0, 10) },
  ];
}
