// backend/routes/experiences.js (ESM)
//
// Forutsetter at du har:
// - authMiddleware (som du allerede har)
// - requirePro (eller tilsvarende) middleware
// - tpConfig + tpSign fra services/travelpayouts


import express from "express";
import axios from "axios";

import authMiddleware from "../middleware/authMiddleware.js";
import requirePro from "../middleware/requirePro.js"; // <-- juster path/navn om din heter noe annet

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeSignature } from "../services/travelpayouts/tpSign.js";

const router = express.Router();

// ---------- Travelpayouts Experiences (start/results) ----------
// NB: endpointene må matche det du faktisk har i TP-avtalen din.
const EXPERIENCE_CREATE_URL =
  "https://api.travelpayouts.com/experience_search/v1/create_search";

const EXPERIENCE_RESULT_URL =
  "https://api.travelpayouts.com/experience_search/v1/result";

/* ------------------------- helpers ------------------------- */

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

function getUserIp(req) {
  if (!req) return "";
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "");
}

function toQuery(paramsObj) {
  const sp = new URLSearchParams();
  Object.entries(paramsObj || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    sp.set(k, String(v));
  });
  return sp;
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

/* ------------------------- routes ------------------------- */

// POST /api/experiences/start
router.post("/experiences/start", authMiddleware, requirePro, async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const body = req.body || {};
    const query = String(body.query || "").trim(); // f.eks. "Eiffel Tower tickets"
    const lang = String(body.lang || "no_NO").trim();
    const currency = String(body.currency || "NOK").trim();

    if (!query) return res.status(400).json({ error: "Mangler query" });

    // Params som sendes til TP-endpointet (GET)
    const params = {
      query,
      customerIP: normalizeIp(getUserIp(req)),
      lang,
      currency,
      waitForResult: body.waitForResult ? 1 : 0,
      marker: tp.marker,
    };

    // ✅ VIKTIG: din makeSignature tar (token, payloadObject)
    // (og ignorerer evt "signature"-felt automatisk)
    const signature = makeSignature(tp.token, params);

    const url = `${EXPERIENCE_CREATE_URL}?${toQuery({ ...params, signature }).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });
    const searchId = pickSearchId(r.data);

    if (!searchId) {
      return res.status(502).json({
        error: "Ugyldig svar fra create_search (experiences)",
        details: r.data || null,
      });
    }

    return res.json({ ok: true, searchId: String(searchId) });
  } catch (e) {
    console.error("❌ /api/experiences/start feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream experiences start failed",
      details: e?.response?.data || null,
    });
  }
});

// POST /api/experiences/results
router.post("/experiences/results", authMiddleware, requirePro, async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const body = req.body || {};
    const searchId = String(body.searchId || "").trim();
    if (!searchId) return res.status(400).json({ error: "Mangler searchId" });

    const limit = Number(body.limit ?? 50);
    const offset = Number(body.offset ?? 0);

    const params = {
      searchId,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      sortBy: body.sortBy || "popularity",
      sortAsc: body.sortAsc === 0 ? 0 : 1,
      marker: tp.marker,
    };

    const signature = makeSignature(tp.token, params);

    const url = `${EXPERIENCE_RESULT_URL}?${toQuery({ ...params, signature }).toString()}`;

    const r = await axios.get(url, { timeout: 20000 });

    return res.json({ ok: true, ...((r && r.data) || {}) });
  } catch (e) {
    console.error("❌ /api/experiences/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream experiences results failed",
      details: e?.response?.data || null,
    });
  }
});

export default router;
