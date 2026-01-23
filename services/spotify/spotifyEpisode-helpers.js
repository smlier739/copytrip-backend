// backend/utils/cleanEpisodeDescription.js (ESM)

export function cleanEpisodeDescription(text) {
  if (!text) return "";

  const raw = String(text);

  const BLOCK_PATTERNS = [
    /vil du annonsere/i,
    /hosted on acast/i,
    /acast\.com\/privacy/i,
    /ta kontakt med (vår|vår(e)?) salgspartner/i,
    /send e-?post til/i,
    /annonser(e|ing)/i,
    /reklame/i,
    /sponsored by/i,
  ];

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean) // fjern tomme linjer tidlig
    .filter((line) => {
      const low = line.toLowerCase();
      return !BLOCK_PATTERNS.some((re) => re.test(low));
    });

  // Slå sammen og rydd whitespace
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // maks 1 tom linje
    .trim();
}
