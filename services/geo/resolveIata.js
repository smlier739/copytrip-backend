//backend/services/geo
import axios from "axios";

const TP_PLACES_URL = "https://autocomplete.travelpayouts.com/places2";

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function pickBestPlace(places = []) {
  if (!Array.isArray(places) || !places.length) return null;

  const city = places.find(p => p?.type === "city" && p?.code);
  if (city) return city;

  const airport = places.find(p => p?.type === "airport" && p?.code);
  if (airport) return airport;

  return places.find(p => p?.code) || null;
}

export async function resolveIataFromPlacename(placeName, locale = "no") {
  const term = String(placeName || "").trim();
  if (!term) return null;

  const r = await axios.get(TP_PLACES_URL, {
    params: {
      term,
      locale,
      "types[]": ["city", "airport"],
    },
    timeout: 12000,
  });

  const raw = Array.isArray(r.data) ? r.data : [];
  const picked = pickBestPlace(raw);
  if (!picked?.code) return null;

  return {
    iata: toUpper(picked.code),
    picked,
    raw,
  };
}
