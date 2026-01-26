// backend/routes/flights.js (ESM)

import express from "express";
import axios from "axios";

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeSignature } from "../services/travelpayouts/tpSign.js";
import { flightSearchCache } from "../services/travelpayouts/flightsCache.js";

const router = express.Router();

// Legacy endpoints (dette er de som faktisk brukes i Travelpayouts realtime flight search)
const TP_LEGACY_START_URL = "https://api.travelpayouts.com/v1/flight_search";
const TP_LEGACY_RESULTS_URL = "https://api.travelpayouts.com/v1/flight_search_results";

/* ------------------------- helpers ------------------------- */

function toUpper(v) {
  return String(v || "").toUpperCase().trim();
}

function safe(v, keep = 4) {
  const s = String(v || "");
  if (!s) return "";
  if (s.length <= keep) return "***";
  return `${s.slice(0, keep)}***`;
}

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

function getUserIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const xri = req.headers?.["x-real-ip"];
  if (xri) return String(xri).trim();
  if (req.ip) return String(req.ip).trim();
  return String(req.socket?.remoteAddress || "").trim();
}

/* ------------------------- START – /api/flights/start ------------------------- */
/**
 * Body eksempel:
 * {
 *   "segments":[{"origin":"OSL","destination":"LHR","date":"2026-02-01"}],
 *   "passengers":{"adults":1,"children":0,"infants":0},
 *   "trip_class":"Y",
 *   "locale":"no",
 *   "currency":"NOK"
 * }
 */
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
        // TP legacy tar ofte strings – vi sender string for å være safe
        adults: String(adults),
        children: String(children),
        infants: String(infants),
      },
      segments: directions.map((d) => ({ origin: d.origin, destination: d.destination, date: d.date })),
      // currency brukes ikke alltid i legacy, men du kan sende det hvis du vil
      currency: toUpper(body.currency || "NOK"),
    };

    const signature = makeSignature(tp.token, payload);

    log("Request:", {
      url: TP_LEGACY_START_URL,
      tokenPreview: safe(tp.token, 4),
      markerPreview: safe(tp.marker, 3),
      realHost: tp.realHost,
      payloadShape: {
        locale: payload.locale,
        trip_class: payload.trip_class,
        segmentsCount: payload.segments.length,
        user_ip: payload.user_ip,
      },
      signaturePreview: safe(signature, 6),
    });

    const r = await axios.post(
      TP_LEGACY_START_URL,
      { ...payload, signature },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: 20000,
      }
    );

    // Legacy kan returnere uuid eller search_id
    const uuid = r.data?.uuid ?? r.data?.search_id ?? r.data?.searchId ?? null;

    log("Response:", {
      status: r.status,
      hasUuid: !!uuid,
      dataKeys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
    });

    if (!uuid) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler uuid/search_id)",
        details: dbg ? r.data : null,
        request_id: rid,
      });
    }

    // cache – vi bruker uuid videre i /results
    flightSearchCache.set(String(uuid), {
      mode: "legacy",
      uuid: String(uuid),
      created_at: Date.now(),
    });

    return res.json({
      ok: true,
      search_id: String(uuid),
      mode: "legacy",
      request_id: rid,
    });
  } catch (err) {
    const status = err?.response?.status || null;
    const data = err?.response?.data || null;
    logErr("FAILED:", { status, message: err?.message || err, dataShort: typeof data === "string" ? data.slice(0, 300) : data });

    return res.status(502).json({
      error: "Upstream start failed (legacy)",
      upstream_status: status,
      details: dbg ? data : null,
      request_id: rid,
    });
  }
});

/* ------------------------- RESULTS – /api/flights/results ------------------------- */
/**
 * Body:
 * { "search_id":"<uuid>" }
 *
 * Returnerer "raw" fra TP så du kan se hva de faktisk gir deg.
 * Appen din må deretter mappe dette til offers, eller du gjør mapping her.
 */
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
      // appen din kaller /results rett etter /start, så om start feiler får du denne
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: rid });
    }

    const url = `${TP_LEGACY_RESULTS_URL}?uuid=${encodeURIComponent(cached.uuid)}`;

    log("Request:", { url });

    // Legacy results er GET
    const r = await axios.get(url, {
      headers: { Accept: "application/json" },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    log("Response:", {
      status: r.status,
      type: typeof r.data,
      keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
    });

    // Return raw – du kan bygge offer-mapping etterpå når du ser formatet i din konto
    return res.json({
      ok: true,
      mode: "legacy",
      request_id: rid,
      data: r.data,
    });
  } catch (err) {
    const status = err?.response?.status || null;
    const data = err?.response?.data || null;
    logErr("FAILED:", {
      status,
      message: err?.message || err,
      dataShort: typeof data === "string" ? data.slice(0, 300) : data,
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
