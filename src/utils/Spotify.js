const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getSpotifyAccessToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error("Mangler SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET i .env");
  }

  const credentials = `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`;
  const encoded = Buffer.from(credentials).toString("base64");

  const resp = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${encoded}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  if (!resp.data?.access_token) {
    throw new Error("Fikk ikke access_token fra Spotify");
  }

  return resp.data.access_token;
}

// -------------------------------------------------------
//  SPOTIFY HELPERS
// -------------------------------------------------------

async function fetchGrenselosEpisodes() {
  const token = await getSpotifyAccessToken();
  const limit = 50;
  let offset = 0;
  let allItems = [];

  while (true) {
    const url =
      `https://api.spotify.com/v1/shows/${process.env.SPOTIFY_SHOW_ID}/episodes` +
      `?market=NO&limit=${limit}&offset=${offset}`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const items = res.data?.items || [];
    allItems = allItems.concat(items);

    if (items.length < limit) {
      break;
    }

    offset += limit;
  }

  const episodes = allItems.map((ep) => ({
    id: ep.id,
    name: ep.name,
    description: ep.description,
    release_date: ep.release_date,
    image: ep.images?.[0]?.url || null,
    external_url: ep.external_urls?.spotify || null
  }));

  episodes.sort((a, b) => {
    if (!a.release_date || !b.release_date) return 0;
    return new Date(a.release_date) - new Date(b.release_date);
  });

  return episodes;
}

