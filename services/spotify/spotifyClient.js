// backend/services/spotify/spotifyClient.js (ESM)

import axios from "axios";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/**
 * Standard GET mot Spotify Web API med Bearer token
 */
export async function spotifyGet(url, accessToken, { params } = {}) {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("spotifyGet: accessToken mangler/ugyldig");
  }

  return axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    timeout: 15000,
  });
}

/**
 * Henter app-token (client_credentials)
 * NB: Les env ved runtime (ikke ved import) for å unngå dotenv-rekkefølgeproblemer.
 */
export async function getSpotifyAccessToken() {
  const clientId = String(process.env.SPOTIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SPOTIFY_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("Mangler SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET i environment");
  }

  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await axios.post(
    SPOTIFY_TOKEN_URL,
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    {
      headers: {
        Authorization: `Basic ${encoded}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    }
  );

  const token = resp?.data?.access_token;
  if (!token) {
    throw new Error("Fikk ikke access_token fra Spotify");
  }

  return token;
}
