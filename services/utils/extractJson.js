// backend/services/utils/extractJson.js (ESM)

/**
 * Robust JSON-ekstraksjon fra LLM-tekst.
 * - Tåler ```json ... ``` / ``` ... ``` blokker
 * - Tåler tekst før/etter JSON
 * - Returnerer null hvis den ikke finner gyldig JSON
 *
 * NB: Returnerer enten object/array/primitive – avhengig av hva som ligger i JSON.
 */
export function extractJson(text) {
  if (text == null) return null;

  let s = String(text).trim();
  if (!s) return null;

  // 1) Rett parse (hvis modellen faktisk svarte ren JSON)
  try {
    return JSON.parse(s);
  } catch {
    // videre
  }

  // 2) ```json ... ``` eller ``` ... ``` blokk
  //    Tar første codefence som ser ut som den kan inneholde JSON
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner) {
      try {
        return JSON.parse(inner);
      } catch {
        // videre
      }
    }
  }

  // 3) Finn JSON-substring ved å lete etter første { ... } eller [ ... ]
  //    Bruker en enkel "balansert"-skanning slik at vi ikke stopper på feil '}'.
  const extracted = extractBalancedJsonSubstring(s);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // videre
    }
  }

  // 4) Siste nød: regex (kan feile ved nested/tekst), men prøv både object og array
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // ignore
    }
  }

  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Returnerer første balanserte JSON-streng som ser ut som et objekt {} eller array [].
 * Returnerer null hvis ikke funnet.
 */
function extractBalancedJsonSubstring(s) {
  const starts = [
    { ch: "{", close: "}" },
    { ch: "[", close: "]" },
  ];

  // Finn tidligste start ({ eller [)
  let startIdx = -1;
  let openCh = null;
  let closeCh = null;

  for (const t of starts) {
    const i = s.indexOf(t.ch);
    if (i !== -1 && (startIdx === -1 || i < startIdx)) {
      startIdx = i;
      openCh = t.ch;
      closeCh = t.close;
    }
  }

  if (startIdx === -1) return null;

  // Skann fremover og finn balansert slutt
  let depth = 0;
  let inString = false;
  let stringQuote = null;
  let escaped = false;

  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if (c === `"` || c === `'`) {
      inString = true;
      stringQuote = c;
      continue;
    }

    if (c === openCh) {
      depth++;
      continue;
    }

    if (c === closeCh) {
      depth--;
      if (depth === 0) {
        return s.slice(startIdx, i + 1).trim();
      }
    }
  }

  return null;
}
