// backend/services/utils/carRentalsService.js (ESM)

function cleanStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isLikelyISODateOrDateTime(s) {
  // Aksepterer "YYYY-MM-DD" eller ISO datetime som starter med det
  const t = cleanStr(s);
  return /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(t);
}

function normalizeDateHint(s) {
  const t = cleanStr(s);
  if (!t) return "";
  if (!isLikelyISODateOrDateTime(t)) return "";
  // Bruk kun dato-delen for søk (stødigere)
  return t.slice(0, 10);
}

export function makeCarRentalUrl({ queryText, pickupISO, dropoffISO } = {}) {
  const qText = cleanStr(queryText);
  const pickup = normalizeDateHint(pickupISO);
  const dropoff = normalizeDateHint(dropoffISO);

  const parts = [
    "bilutleie",
    qText,
    pickup ? `henting ${pickup}` : "",
    dropoff ? `levering ${dropoff}` : "",
  ].filter(Boolean);

  const q = encodeURIComponent(parts.join(" "));

  // Google-søk (ikke Maps)
  return `https://www.google.com/search?q=${q}`;
}

export function searchCarRentals({ queryText, pickupISO, dropoffISO } = {}) {
  const qText = cleanStr(queryText);

  // Hvis du vil tvinge fram mer presist søk, kan du kreve queryText:
  // Hvis du heller vil tillate helt generisk søk, fjern denne blokken.
  if (!qText) {
    return [
      {
        id: "google-search",
        provider: "Søk",
        title: "Finn bilutleie (søk)",
        location: null,
        price_hint: null,
        url: makeCarRentalUrl({ queryText: "Norge", pickupISO, dropoffISO }),
      },
    ];
  }

  const url = makeCarRentalUrl({ queryText: qText, pickupISO, dropoffISO });

  return [
    {
      id: "google-search",
      provider: "Søk",
      title: "Finn bilutleie (søk)",
      location: qText || null,
      price_hint: null,
      url,
    },
  ];
}
