// backend/services/spotify/fetchGrenselosEpisodes.js (ESM)

import { spotifyGet, getSpotifyAccessToken } from "./spotifyClient.js";
import { cleanEpisodeDescription } from "./spotifyEpisodehelpers.js";

const CONTINENT_ORDER = ["Europe", "America", "Asia", "Africa", "Oceania", "Other"];

// Du kan gjøre denne smartere senere (landliste, stedsliste, metadata, osv.).
// Per nå: stabilt og forutsigbart -> basert på keywords i tittel/beskrivelse.
function guessContinent(ep) {
  const hay = `${ep?.name || ""} ${ep?.description || ""}`.toLowerCase();

  // Europe
  if (/(norge|norway|sverige|sweden|danmark|denmark|finland|island|england|uk|scotland|wales|ireland|frankrike|france|spain|italy|tyskland|germany|polen|poland|portugal|hellas|greece|østerrike|austria|praha|paris|london|roma|berlin|oslo|stockholm|københavn|copenhagen)/i.test(hay)) {
    return "Europe";
  }

  // America (Nord+Sør samlet)
  if (/(usa|united states|new york|california|los angeles|mexico|canada|toronto|vancouver|brazil|argentina|peru|chile|colombia|cuba|miami|texas|patagonia)/i.test(hay)) {
    return "America";
  }

  // Asia
  if (/(japan|tokyo|kina|china|beijing|shanghai|thailand|bangkok|vietnam|hanoi|saigon|india|delhi|nepal|kathmandu|indonesia|bali|philippines|manila|singapore|korea|seoul|sri lanka)/i.test(hay)) {
    return "Asia";
  }

  // Africa
  if (/(afrika|africa|marokko|morocco|egypt|cairo|tanzania|zanzibar|kenya|nairobi|south africa|cape town|tunisia|algeria|ethiopia)/i.test(hay)) {
    return "Africa";
  }

  // Oceania
  if (/(australia|sydney|melbourne|new zealand|nz|auckland|oceania|polynesia|fiji|tahiti)/i.test(hay)) {
    return "Oceania";
  }

  return "Other";
}

function normalizeName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function sortEpisodesStable(a, b) {
  // 1) alfabetisk på name (stabilt og intuitivt i admin)
  const an = normalizeName(a?.name);
  const bn = normalizeName(b?.name);
  const byName = an.localeCompare(bn, "nb");
  if (byName !== 0) return byName;

  // 2) fallback på release_date (eldst -> nyest eller motsatt – velg en)
  // Her: nyest først innen samme navn
  const da = a?.release_date || "";
  const db = b?.release_date || "";
  const byDate = db.localeCompare(da);
  if (byDate !== 0) return byDate;

  // 3) siste fallback: id
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

export async function fetchGrenselosEpisodes() {
  const showId = String(process.env.SPOTIFY_SHOW_ID || "").trim();
  if (!showId) throw new Error("SPOTIFY_SHOW_ID er ikke satt");

  const limit = 50;
  let offset = 0;
  const allItems = [];

  let token = await getSpotifyAccessToken();

  while (true) {
    const url = `https://api.spotify.com/v1/shows/${showId}/episodes`;

    let res;
    try {
      res = await spotifyGet(url, token, { params: { market: "NO", limit, offset } });
    } catch (err) {
      if (err?.response?.status === 401) {
        token = await getSpotifyAccessToken();
        res = await spotifyGet(url, token, { params: { market: "NO", limit, offset } });
      } else {
        throw err;
      }
    }

    const items = res?.data?.items || [];
    allItems.push(...items);

    if (items.length < limit) break;
    offset += limit;
  }

  const episodes = allItems.map((ep) => ({
    id: ep.id,
    name: ep.name,
    description: cleanEpisodeDescription(ep.description),
    release_date: ep.release_date,
    image: ep.images?.[0]?.url || null,
    external_url: ep.external_urls?.spotify || null,
  }));

  // Gruppér + sorter deterministisk
  const temp = {};
  for (const ep of episodes) {
    const c = guessContinent(ep);
    if (!temp[c]) temp[c] = [];
    temp[c].push(ep);
  }

  // Sortér innen hver gruppe
  for (const k of Object.keys(temp)) {
    temp[k].sort(sortEpisodesStable);
  }

  // Returnér med fast nøkkelrekkefølge (viktig for “ikke-vilkårlig” visning)
  const episodesByContinent = {};
  for (const k of CONTINENT_ORDER) {
    if (temp[k]?.length) episodesByContinent[k] = temp[k];
  }
  // Legg til evt. “ukjente” kontinentnøkler til slutt (og sortér nøkkelnavn)
  const extraKeys = Object.keys(temp).filter((k) => !CONTINENT_ORDER.includes(k)).sort();
  for (const k of extraKeys) episodesByContinent[k] = temp[k];

  return { episodesByContinent };
}
