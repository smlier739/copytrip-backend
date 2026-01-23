// backend/services/packing/normalizePackingForClient.js (ESM)

import { normalizePackingToFourCategoriesSmart } from "./normalizePackingToFourCategoriesSmart.js";

const CATS = ["Klær", "Toalettsaker", "Elektronikk", "Annet"];

function safeText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function asArray(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v;

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // kan være JSON-string
    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sanitizeGroup(cat, items) {
  const category = CATS.includes(cat) ? cat : null;
  if (!category) return null;

  const arr = Array.isArray(items) ? items : typeof items === "string" ? [items] : [];
  const cleanItems = arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 10);

  return { category, items: cleanItems };
}

function isAlreadyFourCategoryFormat(packing) {
  if (!Array.isArray(packing)) return false;

  const cats = packing
    .map((g) => (g && typeof g === "object" ? String(g.category || "").trim() : ""))
    .filter(Boolean);

  if (cats.length !== 4) return false;

  // må inneholde alle 4 (rekkefølge kan være annerledes)
  return CATS.every((c) => cats.includes(c));
}

/**
 * Normaliserer packing_list til klientformat:
 * [
 *  { category: "Klær", items: [...] },
 *  { category: "Toalettsaker", items: [...] },
 *  { category: "Elektronikk", items: [...] },
 *  { category: "Annet", items: [...] }
 * ]
 */
export function normalizePackingForClient(rawPacking, tripContextText = "") {
  const ctx = safeText(tripContextText);

  // 1) Hvis allerede i riktig 4-kategori-format: sanitér + re-ordne
  const maybe = asArray(rawPacking);
  if (isAlreadyFourCategoryFormat(maybe)) {
    const byCat = new Map();

    for (const g of maybe) {
      if (!g || typeof g !== "object") continue;
      const cat = String(g.category || "").trim();
      const sanitized = sanitizeGroup(cat, g.items);
      if (!sanitized) continue;
      byCat.set(cat, sanitized.items);
    }

    return CATS.map((cat) => ({
      category: cat,
      items: (byCat.get(cat) || []).slice(0, 10),
    }));
  }

  // 2) Alt annet: bruk smart-normalisering
  // normalizePackingToFourCategoriesSmart tåler string/array/object
  const normalized = normalizePackingToFourCategoriesSmart(rawPacking, ctx);

  // 3) Siste sikkerhetsnett: sørg for riktig struktur uansett hva som kom tilbake
  const mapBack = new Map();
  if (Array.isArray(normalized)) {
    for (const g of normalized) {
      if (!g || typeof g !== "object") continue;
      const cat = String(g.category || "").trim();
      const sg = sanitizeGroup(cat, g.items);
      if (!sg) continue;
      mapBack.set(cat, sg.items);
    }
  }

  return CATS.map((cat) => ({
    category: cat,
    items: (mapBack.get(cat) || []).slice(0, 10),
  }));
}
