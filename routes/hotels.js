// backend/routes/hotels.js (ESM)

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

// --------------------------------------------------
// helpers
// --------------------------------------------------

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

// --------------------------------------------------
// POST /api/hotels/start
// --------------------------------------------------
router.post("/hotels/start", authMiddleware, async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const body = req.body || {};

    const iata = String(body.iata || "").trim().toUpperCase();
    const checkIn = String(body.checkIn || "").trim();   // YYYY-MM-DD
    const checkOut = String(body.checkOut || "").trim(); // YYYY-MM-DD

    if (!iata || !checkIn || !checkOut) {
      return res.status(400).json({ error: "Mangler iata/checkIn/checkOut" });
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

    return res.json({ ok: true, searchId: String(searchId) });
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
