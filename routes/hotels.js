// routes/hotels.js (ESM)

import express from "express";
import axios from "axios";

import authMiddleware from "../middleware/authMiddleware.js";

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeSignature } from "../services/travelpayouts/tpSign.js";

const router = express.Router();

// --------------------------------------------------
// Travelpayouts Hotels endpoints
// --------------------------------------------------
const HOTEL_CREATE_URL =
  "https://api.travelpayouts.com/hotellook_search/v1/create_search";

const HOTEL_RESULT_URL =
  "https://api.travelpayouts.com/hotellook_search/v1/result";

// Travelpayouts Places Autocomplete (for IATA lookup)
const TP_PLACES_URL = "https://autocomplete.travelpayouts.com/places2";

// --------------------------------------------------
// helpers
// --------------------------------------------------

async function resolveIataFromPlaceName(placeName, locale = "no") {
  const term = String(placeName || "").trim();
  if (!term) return null;

  const r = await axios.get("https://autocomplete.travelpayouts.com/places2", {
    params: {
      term,
      locale,
      "types[]": ["city", "airport"],
    },
    timeout: 10000,
  });

  const arr = Array.isArray(r.data) ? r.data : [];

  // Prefer airport iata hvis finnes, ellers city code
  const first = arr[0];
  if (!first) return null;

  const code = first.code || first.iata || first.airport_iata || null;
  return code ? String(code).trim().toUpperCase() : null;
}

function toQuery(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    p.set(k, String(v));
  }
  return p;
}

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

function getUserIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "");
}

function withChildAges(params, childAges = []) {
  const out = { ...params };
  const ages = Array.isArray(childAges) ? childAges : [];
  ages.forEach((age, idx) => {
    out[`childAge${idx + 1}`] = Number(age) || 1;
  });
  return out;
}

function pickSearchId(data) {
  return (
    data?.searchId ||
    data?.search_id ||
    data?.data?.searchId ||
    data?.data?.search_id ||
    null
  );
}

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

// Prefer city over airport; return best guess
function pickBestPlace(places = []) {
  const arr = Array.isArray(places) ? places : [];
  if (!arr.length) return null;

  // Typical fields: { code, type, name, city_name, country_name }
  const city = arr.find((p) => String(p?.type || "").toLowerCase() === "city");
  if (city?.code) return city;

  const airport = arr.find((p) => String(p?.type || "").toLowerCase() === "airport");
  if (airport?.code) return airport;

  const any = arr.find((p) => p?.code);
  return any || null;
}

// Resolve missing iata from a human place name like "Sal"
async function resolveIataFromPlaceName(placeName, locale = "no") {
  const term = String(placeName || "").trim();
  if (!term) return { iata: "", picked: null, raw: null };

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

  const iata = picked?.code ? toUpper(picked.code) : "";
  return { iata, picked, raw };
}

// --------------------------------------------------
// POST /api/hotels/start
// Body supports:
//   - iata (preferred)
//   - OR placeName / destinationName / query  (fallback -> autocomplete -> iata)
//   - checkIn, checkOut (required)
// --------------------------------------------------
router.post("/hotels/start", authMiddleware, async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const body = req.body || {};

    let iata = String(body.iata || "").trim().toUpperCase();
    const placeName = String(body.placeName || "").trim();

    if (!iata && placeName) {
      // prøv å resolve fra placeName
      const resolved = await resolveIataFromPlaceName(placeName, (body.lang || "no_NO").startsWith("no") ? "no" : "en");
        if (resolved) iata = resolved;
    }
    
    const checkIn = String(body.checkIn || "").trim(); // YYYY-MM-DD
    const checkOut = String(body.checkOut || "").trim(); // YYYY-MM-DD

    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: "Mangler checkIn/checkOut" });
    }

    // 🔁 Fallback: resolve iata from place name if missing
    let resolvedFrom = null;
    if (!iata) {
      const placeName =
        body.placeName ||
        body.destinationName ||
        body.query ||
        body.city ||
        body.destination ||
        "";

      if (placeName) {
        const { iata: resolvedIata, picked } = await resolveIataFromPlaceName(
          placeName,
          (body.lang || "no_NO").startsWith("no") ? "no" : "en"
        );

        if (resolvedIata) {
          iata = resolvedIata;
          resolvedFrom = {
            placeName: String(placeName),
            picked: picked
              ? {
                  code: picked.code,
                  type: picked.type,
                  name: picked.name,
                  city_name: picked.city_name,
                  country_name: picked.country_name,
                }
              : null,
          };
        }
      }
    }

    if (!iata || !checkIn || !checkOut) {
      return res.status(400).json({ error: "Mangler iata (eller kunne ikke resolve) /checkIn/checkOut", details: { placeName } });
    }

    const adultsCount = Number(body.adultsCount ?? 2);
    const childrenCount = Number(body.childrenCount ?? 0);
    const childAges = Array.isArray(body.childAges) ? body.childAges : [];

    const baseParams = {
      iata,
      checkIn,
      checkOut,
      adultsCount,
      childrenCount,
      customerIP: normalizeIp(getUserIp(req)),
      lang: body.lang || "no_NO",
      currency: body.currency || "NOK",
      waitForResult: body.waitForResult ? 1 : 0,
      marker: tp.marker,
    };

    const params = withChildAges(baseParams, childAges);

    const signature = makeSignature(tp.token, params);
    params.signature = signature;

    const url = `${HOTEL_CREATE_URL}?${toQuery(params).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });
    const searchId = pickSearchId(r.data);

    if (!searchId) {
      return res.status(502).json({
        error: "Ugyldig svar fra create_search (hotels)",
        details: r.data || null,
      });
    }

    return res.json({ ok: true, searchId: String(searchId), resolvedIata: iata });
  } catch (e) {
    console.error("❌ /api/hotels/start feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream hotels start failed",
      details: e?.response?.data || null,
    });
  }
});

// --------------------------------------------------
// POST /api/hotels/results
// --------------------------------------------------
router.post("/hotels/results", authMiddleware, async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const body = req.body || {};
    const searchId = String(body.searchId || "").trim();
    if (!searchId) return res.status(400).json({ error: "Mangler searchId" });

    const params = {
      searchId,
      limit: Number(body.limit ?? 50),
      offset: Number(body.offset ?? 0),
      sortBy: body.sortBy || "popularity",
      sortAsc: body.sortAsc === 0 ? 0 : 1,
      marker: tp.marker,
    };

    const signature = makeSignature(tp.token, params);
    params.signature = signature;

    const url = `${HOTEL_RESULT_URL}?${toQuery(params).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });

    return res.json({ ok: true, ...((r && r.data) || {}) });
  } catch (e) {
    console.error("❌ /api/hotels/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream hotels results failed",
      details: e?.response?.data || null,
    });
  }
});

export default router;
