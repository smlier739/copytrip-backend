// backend/services/spotify/fetchGrenselosEpisodes.js (ESM)

import { spotifyGet, getSpotifyAccessToken } from "./spotifyClient.js";

export async function fetchGrenselosEpisodes() {
  const showId = String(process.env.SPOTIFY_SHOW_ID || "").trim();
  if (!showId) {
    throw new Error("SPOTIFY_SHOW_ID er ikke satt");
  }

  const limit = 50;
  let offset = 0;
  const allItems = [];

  // hent token én gang
  let token = await getSpotifyAccessToken();

  while (true) {
    const url = `https://api.spotify.com/v1/shows/${showId}/episodes`;

    let res;
    try {
      res = await spotifyGet(url, token, {
        params: { market: "NO", limit, offset },
      });
    } catch (err) {
      // Robusthet: hvis token av en eller annen grunn er utløpt midt i løkka
      const status = err?.response?.status;
      if (status === 401) {
        token = await getSpotifyAccessToken();
        res = await spotifyGet(url, token, {
          params: { market: "NO", limit, offset },
        });
      } else {
        throw err;
      }
    }

    const items = res?.data?.items || [];
    allItems.push(...items);

    if (items.length < limit) break;
    offset += limit;
  }

  // Map til klientformat
  const episodes = allItems.map((ep) => ({
    id: ep.id,
    name: ep.name,
    description: ep.description,
    release_date: ep.release_date,
    image: ep.images?.[0]?.url || null,
    external_url: ep.external_urls?.spotify || null,
  }));

  // ISO-datoer kan sorteres trygt som strings (eldst -> nyest)
  episodes.sort((a, b) => {
    const da = a.release_date || "";
    const db = b.release_date || "";
    return da.localeCompare(db);
  });

  return episodes;
}
