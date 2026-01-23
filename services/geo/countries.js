// backend/services/geo/countries.js (ESM)

// Minimal ISO2 -> norsk landnavn (utvid etter behov)
export const ISO2_TO_NO = {
  NO: "Norge",
  SE: "Sverige",
  DK: "Danmark",
  FI: "Finland",
  IS: "Island",
  GB: "Storbritannia",
  UK: "Storbritannia",
  US: "USA",
  FR: "Frankrike",
  ES: "Spania",
  IT: "Italia",
  DE: "Tyskland",
  PT: "Portugal",
  NL: "Nederland",
  BE: "Belgia",
  CH: "Sveits",
  AT: "Østerrike",
  PL: "Polen",
  CZ: "Tsjekkia",
  GR: "Hellas",
  TR: "Tyrkia",
};

// Alias (lowercase) -> norsk landnavn
export const COUNTRY_ALIASES_TO_NO = new Map([
  ["norge", "Norge"],
  ["norway", "Norge"],
  ["sverige", "Sverige"],
  ["sweden", "Sverige"],
  ["danmark", "Danmark"],
  ["denmark", "Danmark"],
  ["finland", "Finland"],
  ["island", "Island"],

  ["storbritannia", "Storbritannia"],
  ["united kingdom", "Storbritannia"],
  ["england", "Storbritannia"],
  ["uk", "Storbritannia"],

  ["usa", "USA"],
  ["united states", "USA"],
  ["united states of america", "USA"],

  ["frankrike", "Frankrike"],
  ["france", "Frankrike"],
  ["spania", "Spania"],
  ["spain", "Spania"],
  ["italia", "Italia"],
  ["italy", "Italia"],
  ["tyskland", "Tyskland"],
  ["germany", "Tyskland"],
  ["hellas", "Hellas"],
  ["greece", "Hellas"],
  ["portugal", "Portugal"],
  ["nederland", "Nederland"],
  ["netherlands", "Nederland"],
  ["belgia", "Belgia"],
  ["belgium", "Belgia"],
  ["sveits", "Sveits"],
  ["switzerland", "Sveits"],
  ["østerrike", "Østerrike"],
  ["austria", "Østerrike"],
  ["polen", "Polen"],
  ["poland", "Polen"],
  ["tsjekkia", "Tsjekkia"],
  ["czechia", "Tsjekkia"],
  ["czech republic", "Tsjekkia"],
  ["tyrkia", "Tyrkia"],
  ["turkey", "Tyrkia"],
]);

/**
 * Normaliserer en “land-kandidat”:
 * - strip quotes, "Land: X"
 * - map ISO2 -> norsk (NO/ES/IT)
 * - map alias (engelsk/norsk/variasjoner) -> norsk
 * Returnerer null hvis "UKJENT"/tom.
 */
export function normalizeCountryCandidate(input) {
  const t = String(input || "").trim();
  if (!t) return null;

  const oneLine = t.split("\n")[0].trim();
  const stripped = oneLine.replace(/^["']|["']$/g, "").trim();
  if (!stripped) return null;
  if (/^ukjent$/i.test(stripped)) return null;

  const m = stripped.match(/^(land|country)\s*:\s*(.+)$/i);
  const candidate = (m?.[2] ? m[2] : stripped).trim();

  if (/^[A-Z]{2}$/.test(candidate)) {
    return ISO2_TO_NO[candidate] || candidate;
  }

  const low = candidate.toLowerCase();
  return COUNTRY_ALIASES_TO_NO.get(low) || candidate;
}
