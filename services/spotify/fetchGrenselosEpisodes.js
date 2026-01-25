// backend/services/spotify/fetchGrenselosEpisodes.js (ESM)

import { spotifyGet, getSpotifyAccessToken } from "./spotifyClient.js";
import { cleanEpisodeDescription } from "./spotifyEpisodehelpers.js";
import { detectContinent } from "./continentDetector.js";

const CONTINENT_ORDER = [
  "Europe",
  "America",
  "Asia",
  "Africa",
  "Oceania",
  "Other"
];

function emptyGrouped() {
  return {
    Europe: [],
    America: [],
    Asia: [],
    Africa: [],
    Oceania: [],
    Other: []
  };
}

export async function fetchGrenselosEpisodes() {
  const showId = String(process.env.SPOTIFY_SHOW_ID || "").trim();
  if (!showId) {
    throw new Error("SPOTIFY_SHOW_ID er ikke satt");
  }

  const limit = 50;
  let offset = 0;
  const allItems = [];

  let token = await getSpotifyAccessToken();

  while (true) {
    const url = `https://api.spotify.com/v1/shows/${showId}/episodes`;

    let res;
    try {
      res = await spotifyGet(url, token, {
        params: { market: "NO", limit, offset },
      });
    } catch (err) {
      if (err?.response?.status === 401) {
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

  const grouped = emptyGrouped();

  for (const ep of allItems) {
    const description = cleanEpisodeDescription(ep.description);

    const continent = detectContinent(
      `${ep.name || ""} ${description || ""}`
    );

    const episode = {
      id: ep.id,
      name: ep.name,
      description,
      release_date: ep.release_date,
      image: ep.images?.[0]?.url || null,
      external_url: ep.external_urls?.spotify || null,
      continent
    };

    if (!grouped[continent]) {
      grouped.Other.push(episode);
    } else {
      grouped[continent].push(episode);
    }
  }

  // Sorter innen hver verdensdel (eldst → nyest)
  for (const key of CONTINENT_ORDER) {
    grouped[key].sort((a, b) =>
      (a.release_date || "").localeCompare(b.release_date || "")
    );
  }

  return grouped;
}
