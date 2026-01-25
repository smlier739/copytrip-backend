// backend/services/spotify/spotifyEpisodehelpers.js (ESM)

export function cleanEpisodeDescription(input) {
  if (!input || typeof input !== "string") return null;

  let text = input.trim();

  // 1) Fjern URLs (Spotify, Instagram, Linktree, etc.)
  text = text.replace(/https?:\/\/\S+/gi, "");

  // 2) Fjern vanlige CTA / standardfraser
  const junkPatterns = [
    /følg oss på.*$/i,
    /abonner på.*$/i,
    /hør flere episoder.*$/i,
    /nye episoder.*hver.*$/i,
    /produsert av.*$/i,
    /ansvarlig redaktør.*$/i,
    /kontakt oss.*$/i,
    /se mer på.*$/i,
    /instagram.*$/i,
    /facebook.*$/i,
    /tiktok.*$/i,
    /snapchat.*$/i
  ];

  for (const rx of junkPatterns) {
    text = text.replace(rx, "");
  }

  // 3) Rydd opp whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")   // maks to linjeskift
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // 4) For korte beskrivelser er ofte bare støy
  if (text.length < 30) return null;

  return text;
}
