// backend/src/config/spotify.js
import axios from "axios";

export async function getSpotifyAccessToken() {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error("Mangler SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET i .env");
  }

  const encoded = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const resp = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    { headers: { Authorization: `Basic ${encoded}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (!resp.data?.access_token) throw new Error("Fikk ikke access_token fra Spotify");
  return resp.data.access_token;
}
