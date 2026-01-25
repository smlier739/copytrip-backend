// backend/services/spotify/continentDetector.js (ESM)

const CONTINENT_KEYWORDS = {
  Europe: [
    "norge", "sverige", "danmark", "finland", "island",
    "frankrike", "italia", "spania", "portugal", "tyskland",
    "europa", "balkan", "alper", "paris", "roma", "berlin", "london"
  ],
  America: [
    "usa", "united states", "canada", "mexico",
    "peru", "chile", "argentina", "brasil",
    "amerika", "new york", "los angeles", "patagonia"
  ],
  Asia: [
    "asia", "japan", "kina", "india", "nepal", "thailand",
    "vietnam", "indonesia", "sibir", "mongolia"
  ],
  Africa: [
    "afrika", "kenya", "tanzania", "marokko",
    "etiopia", "namibia", "sør-afrika", "sahara"
  ],
  Oceania: [
    "australia", "new zealand", "oceania", "oseania",
    "tasmania", "pacific"
  ]
};

export function detectContinent(text) {
  if (!text) return "Other";

  const t = text.toLowerCase();

  for (const [continent, keywords] of Object.entries(CONTINENT_KEYWORDS)) {
    if (keywords.some((k) => t.includes(k))) {
      return continent;
    }
  }

  return "Other";
}
