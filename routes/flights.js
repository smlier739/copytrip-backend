// backend/routes/flights.js (ESM)

import express from "express";
import axios from "axios";

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeSignature } from "../services/travelpayouts/tpSign.js";
import { flightSearchCache } from "../services/travelpayouts/flightsCache.js";

const router = express.Router();

const TP_LEGACY_START_URL = "https://api.travelpayouts.com/v1/flight_search";
const TP_LEGACY_RESULTS_URL = "https://api.travelpayouts.com/v1/flight_search_results";

const START_TIMEOUT_MS = 20000;
const RESULTS_TIMEOUT_MS = 45000; // ↑ viktig for Render / mobilnett

function dbgEnabled() {
  return String(process.env.TP_DEBUG || process.env.TRAVELPAYOUTS_DEBUG || "")
    .trim()
    .toLowerCase() === "true";
}

function getReqId(req) {
  return (
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    `rid_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
}

function toUpper(v) {
  return String(v || "").toUpperCase().trim();
}

function safe(v, keep = 4) {
  const s = String(v || "");
  if (!s) return "";
  if (s.length <= keep) return "***";
  return `${s.slice(0, keep)}***`;
}

function getUserIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const xri = req.headers?.["x-real-ip"];
  if (xri) return String(xri).trim();
  if (req.ip) return String(req.ip).trim();
  return String(req.socket?.remoteAddress || "").trim();
}

function shortenData(data, max = 500) {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, max);
  try {
    const s = JSON.stringify(data);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// DEBUG endpoint (for å bekrefte deploy/version + env-status)
// ---------------------------------------------------------
router.get("/flights/debug", (req, res) => {
  const tp = getTpConfig();
  res.json({
    ok: true,
    version: "2026-01-26-legacy-first-v2",
    debugOn: dbgEnabled(),
    cfg: {
      hasToken: !!tp?.token,
      hasMarker: !!tp?.marker,
      hasRealHost: !!tp?.realHost,
      realHost: tp?.realHost || null,
      tokenPreview: safe(tp?.token, 4),
      markerPreview: safe(tp?.marker, 3),
      userIp: getUserIp(req) || null,
    },
  });
});

// ---------------------------------------------------------
// START – /api/flights/start
// ---------------------------------------------------------
router.post("/flights/start", async (req, res) => {
  const rid = getReqId(req);
  const dbg = dbgEnabled();
  const log = (...args) => dbg && console.log(`[TP][start][${rid}]`, ...args);
  const logErr = (...args) => console.error(`[TP][start][${rid}]`, ...args);

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) {
      log("Config error:", okCfg);
      return res.status(okCfg.status).json({ error: okCfg.error, request_id: rid });
    }

    const body = req.body || {};
    const segments = Array.isArray(body.segments) ? body.segments : [];

    const directions = segments
      .map((s) => ({
        origin: toUpper(s?.origin),
        destination: toUpper(s?.destination),
        date: String(s?.date || "").trim(), // YYYY-MM-DD
      }))
      .filter((d) => d.origin && d.destination && d.date);

    if (!directions.length) {
      return res.status(400).json({
        error: "Minst ett segment kreves (origin, destination, date)",
        request_id: rid,
      });
    }
    if (directions.some((d) => d.origin === d.destination)) {
      return res.status(400).json({ error: "origin og destination kan ikke være like", request_id: rid });
    }

    const passengers = body.passengers || {};
    const adults = Number(passengers.adults ?? 1);
    const children = Number(passengers.children ?? 0);
    const infants = Number(passengers.infants ?? 0);

    if (
      !Number.isFinite(adults) ||
      adults < 1 ||
      !Number.isFinite(children) ||
      children < 0 ||
      !Number.isFinite(infants) ||
      infants < 0 ||
      infants > adults
    ) {
      return res.status(400).json({ error: "Ugyldig passasjer-oppsett", request_id: rid });
    }

    const payload = {
      marker: tp.marker,
      host: tp.realHost, // f.eks. "podtech.no"
      user_ip: getUserIp(req) || "127.0.0.1",
      locale: body.locale || "no",
      trip_class: toUpper(body.trip_class || "Y"),
      passengers: {
        adults: String(adults),
        children: String(children),
        infants: String(infants),
      },
      segments: directions.map((d) => ({
        origin: d.origin,
        destination: d.destination,
        date: d.date,
      })),
      currency: toUpper(body.currency || "NOK"),
    };

    const signature = makeSignature(tp.token, payload);

    log("Request -> legacy start", {
      url: TP_LEGACY_START_URL,
      realHost: tp.realHost,
      tokenPreview: safe(tp.token, 4),
      markerPreview: safe(tp.marker, 3),
      signaturePreview: safe(signature, 6),
      segments: payload.segments,
      passengers: payload.passengers,
      locale: payload.locale,
      trip_class: payload.trip_class,
      user_ip: payload.user_ip,
    });

    const r = await axios.post(
      TP_LEGACY_START_URL,
      { ...payload, signature },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: START_TIMEOUT_MS,
      }
    );

    const uuid = r.data?.uuid ?? r.data?.search_id ?? r.data?.searchId ?? null;

    log("Response <- legacy start", {
      status: r.status,
      hasUuid: !!uuid,
      dataShort: shortenData(r.data, 600),
    });

    if (!uuid) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler uuid/search_id)",
        details: dbg ? r.data : null,
        request_id: rid,
      });
    }

    // Cache: lagre siste "ok results" senere for timeout-fallback
    flightSearchCache.set(String(uuid), {
      mode: "legacy",
      uuid: String(uuid),
      created_at: Date.now(),
      last_ok_results: null,
      last_ok_at: null,
    });

    return res.json({
      ok: true,
      mode: "legacy",
      search_id: String(uuid),
      request_id: rid,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;

    logErr("FAILED", {
      status,
      message: err?.message || String(err),
      dataShort: shortenData(data, 600),
    });

    return res.status(502).json({
      error: "Upstream start failed (legacy)",
      upstream_status: status,
      details: dbg ? data : null,
      request_id: rid,
    });
  }
});

// ---------------------------------------------------------
// RESULTS – /api/flights/results
// ---------------------------------------------------------
router.post("/flights/results", async (req, res) => {
  const rid = getReqId(req);
  const dbg = dbgEnabled();
  const log = (...args) => dbg && console.log(`[TP][results][${rid}]`, ...args);
  const logErr = (...args) => console.error(`[TP][results][${rid}]`, ...args);

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: rid });

    const { search_id } = req.body || {};
    const sid = String(search_id || "").trim();
    if (!sid) return res.status(400).json({ error: "Mangler search_id", request_id: rid });

    const cached = flightSearchCache.get(sid);
    if (!cached?.uuid) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: rid });
    }

    const url = `${TP_LEGACY_RESULTS_URL}?uuid=${encodeURIComponent(cached.uuid)}`;

    log("Request -> legacy results", { url, timeout: RESULTS_TIMEOUT_MS });

    const r = await axios.get(url, {
      headers: { Accept: "application/json" },
      timeout: RESULTS_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    // Oppdater cache med siste OK
    const nextCached = {
      ...cached,
      last_ok_results: r.data,
      last_ok_at: Date.now(),
    };
    flightSearchCache.set(sid, nextCached);

    log("Response <- legacy results", {
      status: r.status,
      bytesHint: shortenData(r.data, 50)?.length || null,
      dataShort: shortenData(r.data, 800),
    });

    return res.json({
      ok: true,
      mode: "legacy",
      request_id: rid,
      data: r.data,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;

    // Timeout: returner siste ok results hvis vi har det (mye bedre UX)
    const isTimeout =
      err?.code === "ECONNABORTED" || String(err?.message || "").toLowerCase().includes("timeout");

    if (isTimeout) {
      try {
        const { search_id } = req.body || {};
        const sid = String(search_id || "").trim();
        const cached = sid ? flightSearchCache.get(sid) : null;

        if (cached?.last_ok_results) {
          logErr("TIMEOUT -> returning cached last_ok_results", {
            sid,
            last_ok_age_ms: Date.now() - (cached.last_ok_at || Date.now()),
          });

          return res.json({
            ok: true,
            mode: "legacy",
            request_id: rid,
            is_cached: true,
            data: cached.last_ok_results,
          });
        }
      } catch {
        // ignore
      }
    }

    logErr("FAILED", {
      status,
      message: err?.message || String(err),
      dataShort: shortenData(data, 600),
      code: err?.code || null,
    });

    return res.status(502).json({
      error: "Upstream results failed (legacy)",
      upstream_status: status,
      details: dbg ? data : null,
      request_id: rid,
    });
  }
});

export default router;
