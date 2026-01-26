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
const RESULTS_TIMEOUT_MS = 65000;

function dbgEnabled() {
  return String(process.env.TP_DEBUG || process.env.TRAVELPAYOUTS_DEBUG || "")
    .trim()
    .toLowerCase() === "true";
}

function rid() {
  return `rid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safe(v, keep = 4) {
  const s = String(v || "");
  if (!s) return "";
  if (s.length <= keep) return "***";
  return `${s.slice(0, keep)}***`;
}

function toUpper(v) {
  return String(v || "").toUpperCase().trim();
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function pickObj(v, keys) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    for (const k of keys) {
      const x = v?.[k];
      if (x != null && x !== "") return x;
    }
  }
  return null;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function fmtTimeHHMM(v) {
  if (!v) return "";
  const s = String(v);
  if (s.includes("T")) return s.split("T")[1]?.slice(0, 5) || "";
  if (s.includes(" ")) return s.split(" ")[1]?.slice(0, 5) || "";
  return s.slice(0, 5);
}

function fmtDurationMins(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n)) return "";
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h > 0 ? `${h}t ${m}m` : `${m}m`;
}

function pickPriceFromProposal(p) {
  const c = p?.price ?? p?.unified_price ?? p?.total_price ?? p?.amount ?? null;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string") return num(c);
  if (c && typeof c === "object") return num(c.amount ?? c.value ?? c.price ?? c.total);
  return null;
}

function pickCurrency(p, t, data) {
  const c =
    (typeof p?.price === "object" ? p.price?.currency : null) ||
    (typeof p?.unified_price === "object" ? p.unified_price?.currency : null) ||
    (typeof p?.price_per_person === "object" ? p.price_per_person?.currency : null) ||
    p?.currency ||
    t?.currency ||
    data?.currency ||
    data?.search_params?.currency_code ||
    data?.search_params?.currency ||
    "NOK";
  return toUpper(c || "NOK");
}

// Enkel “er ferdig?”-deteksjon på tvers av varianter
function inferIsOver(data) {
  if (!data) return false;
  if (typeof data.is_over === "boolean") return data.is_over;
  const st = String(data.status || data.search_status || data.state || "").toLowerCase();
  return st === "done" || st === "completed" || st === "complete" || st === "finished";
}

function inferLastTs(data, fallback = 0) {
  const raw =
    data?.last_update_timestamp ??
    data?.last_update ??
    data?.timestamp ??
    data?.updated_at ??
    null;

  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Normaliser Travelpayouts legacy results -> appens offers-format.
 * Vi forsøker først “new-ish” structure (tickets + flight_legs).
 * Hvis schema er annerledes, returnerer vi offers: [] (men ok=true),
 * og logger raw i debug.
 */
function buildOffersFromTpResults(data, searchId) {
  const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
  const legsArr = Array.isArray(data?.flight_legs) ? data.flight_legs : [];

  // hvis schema ikke matcher, gi tomt men “ok”
  if (!tickets.length || !legsArr.length) {
    return {
      offers: [],
      meta: { schema: "unknown_or_empty", tickets: tickets.length, legs: legsArr.length },
    };
  }

  const legsById = new Map();
  for (const leg of legsArr) {
    const id =
      leg?.id ??
      leg?._id ??
      leg?.uuid ??
      leg?.leg_id ??
      leg?.flight_leg_id ??
      leg?.flight_id ??
      null;
    if (id != null) legsById.set(String(id), leg);
  }

  const resolveLeg = (ref) => {
    if (ref == null) return null;
    if (typeof ref === "object") return ref;

    const byId = legsById.get(String(ref));
    if (byId) return byId;

    const idx = typeof ref === "number" ? ref : Number(ref);
    if (Number.isInteger(idx) && idx >= 0 && idx < legsArr.length) return legsArr[idx];

    return null;
  };

  const legOrigin = (leg) =>
    pick(leg, ["origin", "from", "origin_iata", "origin_code", "departure_airport", "airport_from"]);
  const legDest = (leg) =>
    pick(leg, ["destination", "to", "destination_iata", "destination_code", "arrival_airport", "airport_to"]);

  const legDep = (leg) =>
    pick(leg, [
      "local_departure_date_time",
      "departure_at",
      "local_departure",
      "departure_time",
      "depart_at",
      "departure_datetime",
      "time_departure",
    ]);

  const legArr = (leg) =>
    pick(leg, [
      "local_arrival_date_time",
      "arrival_at",
      "local_arrival",
      "arrival_time",
      "arrive_at",
      "arrival_datetime",
      "time_arrival",
    ]);

  const legDurationMins = (leg) => {
    const raw = pick(leg, ["duration", "duration_mins", "duration_minutes", "travel_time", "flight_time"]);
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 10000 ? Math.round(n / 60) : n;
  };

  const legAirline = (leg) => {
    const direct = pick(leg, [
      "airline",
      "carrier",
      "marketing_carrier",
      "operating_carrier",
      "airline_code",
      "carrier_code",
      "airline_iata",
    ]);
    if (direct && typeof direct === "string") return toUpper(direct);

    const obj = leg?.airline || leg?.carrier || leg?.marketing_carrier || leg?.operating_carrier || null;
    const code = pickObj(obj, ["iata", "iata_code", "code", "id", "carrier_code", "airline_code"]);
    return toUpper(code || "");
  };

  const legFlightNo = (leg) => {
    const direct = pick(leg, ["flight_number", "flight_no", "flightNumber", "flight_num", "number"]);
    if (direct != null && direct !== "") return toUpper(String(direct));

    const obj = leg?.flight || leg?.flight_number_obj || null;
    const n = pickObj(obj, ["number", "flight_number", "flightNo", "no"]);
    return n != null && n !== "" ? toUpper(String(n)) : "";
  };

  const offers = [];
  let counter = 0;

  for (const t of tickets) {
    const proposals = Array.isArray(t?.proposals) ? t.proposals : [];
    const segs = Array.isArray(t?.segments) ? t.segments : [];
    const seg0 = segs[0] || null;

    const flightRefs = Array.isArray(seg0?.flights) ? seg0.flights : [];
    const legs = flightRefs.map(resolveLeg).filter(Boolean);

    const firstLeg = legs[0] || null;
    const lastLeg = legs[legs.length - 1] || null;

    const origin =
      (firstLeg && legOrigin(firstLeg)) ||
      pick(t, ["origin", "from", "origin_iata", "origin_code"]) ||
      "";

    const destination =
      (lastLeg && legDest(lastLeg)) ||
      pick(t, ["destination", "to", "destination_iata", "destination_code"]) ||
      "";

    const dep =
      (firstLeg && legDep(firstLeg)) ||
      pick(t, ["local_departure_date_time", "departure_at", "local_departure", "departure_time"]) ||
      null;

    const arr =
      (lastLeg && legArr(lastLeg)) ||
      pick(t, ["local_arrival_date_time", "arrival_at", "local_arrival", "arrival_time"]) ||
      null;

    const durationSum =
      legs.length > 0
        ? legs.reduce((acc, leg) => acc + (legDurationMins(leg) || 0), 0)
        : (num(t?.duration) ?? num(t?.total_duration) ?? num(t?.travel_time) ?? null);

    const depTime = fmtTimeHHMM(dep);
    const arrTime = fmtTimeHHMM(arr);
    const durationText = durationSum != null ? fmtDurationMins(durationSum) : "";
    const routeText = origin && destination ? `${toUpper(origin)} → ${toUpper(destination)}` : "";

    const stops =
      legs.length > 0
        ? Math.max(0, legs.length - 1)
        : Array.isArray(seg0?.transfers)
        ? seg0.transfers.length
        : null;

    const stopsText = stops == null ? "" : stops === 0 ? "Direkte" : `${stops} stopp`;

    const airlinesText = legs.length ? uniq(legs.map(legAirline)).filter(Boolean).join(", ") : "";
    const flightNosText = legs.length ? uniq(legs.map(legFlightNo)).filter(Boolean).join(", ") : "";

    for (const p of proposals) {
      const offer_id = `${String(searchId)}:${counter}`;
      counter += 1;

      const tp_proposal_id =
        p?.id ?? p?.proposal_id ?? p?.uuid ?? p?.proposalId ?? p?.click_id ?? p?.clickId ?? null;

      const price = pickPriceFromProposal(p);
      const currency = pickCurrency(p, t, data);

      offers.push({
        offer_id,
        tp_proposal_id: tp_proposal_id != null ? String(tp_proposal_id) : null,
        price: typeof price === "number" ? price : null,
        currency,
        depTime,
        arrTime,
        durationText,
        routeText,
        stopsText,
        airlinesText,
        flightNosText,
        agentText: "",
        signature: t?.signature || null,
      });
    }
  }

  offers.sort((a, b) => (a.price ?? 1e18) - (b.price ?? 1e18));
  return { offers, meta: { schema: "tickets+flight_legs", tickets: tickets.length, legs: legsArr.length } };
}

/* ---------------------------------------------------------
   START – /api/flights/start (LEGACY)
--------------------------------------------------------- */
router.post("/flights/start", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });

    const body = req.body || {};
    const segments = Array.isArray(body.segments) ? body.segments : [];

    const directions = segments
      .map((s) => ({
        origin: toUpper(s?.origin),
        destination: toUpper(s?.destination),
        date: String(s?.date || "").trim(),
      }))
      .filter((d) => d.origin && d.destination && d.date);

    if (!directions.length) {
      return res.status(400).json({ error: "Minst ett segment kreves (origin, destination, date)", request_id: requestId });
    }
    if (directions.some((d) => d.origin === d.destination)) {
      return res.status(400).json({ error: "origin og destination kan ikke være like", request_id: requestId });
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
      return res.status(400).json({ error: "Ugyldig passasjer-oppsett", request_id: requestId });
    }

    const payload = {
      marker: tp.marker,
      host: tp.realHost, // "podtech.no"
      user_ip: String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.ip || "").split(",")[0].trim() || "127.0.0.1",
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

    if (dbg) {
      console.log(`[TP][start][${requestId}] cfg`, {
        realHost: tp.realHost,
        hasToken: !!tp.token,
        hasMarker: !!tp.marker,
        tokenPreview: safe(tp.token, 4),
        markerPreview: safe(tp.marker, 3),
      });
      console.log(`[TP][start][${requestId}] payload`, {
        segments: payload.segments,
        passengers: payload.passengers,
        locale: payload.locale,
        currency: payload.currency,
        trip_class: payload.trip_class,
        user_ip: payload.user_ip,
        signaturePreview: safe(signature, 6),
      });
    }

    const r = await axios.post(
      TP_LEGACY_START_URL,
      { ...payload, signature },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: START_TIMEOUT_MS,
      }
    );

    console.log(`[TP][start][${rid}] response`, {
      status: response.status,
      keys: response.data && typeof response.data === "object" ? Object.keys(response.data) : null,
      search_id: response.data?.search_id,
      results_url: response.data?.results_url,
    });
      
    const uuid = r.data?.uuid ?? r.data?.search_id ?? r.data?.searchId ?? null;

    if (dbg) {
      console.log(`[TP][start][${requestId}] upstream`, {
        status: r.status,
        uuid: uuid ? safe(uuid, 8) : null,
      });
    }

    if (!uuid) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler uuid/search_id)",
        details: dbg ? r.data : null,
        request_id: requestId,
      });
    }

    flightSearchCache.set(String(uuid), {
      mode: "legacy",
      uuid: String(uuid),
      created_at: Date.now(),
      last_ok_results: null,
      last_ok_at: null,
    });

    return res.json({
      ok: true,
      search_id: String(uuid),
      request_id: requestId,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;

    console.error(`[TP][start][${requestId}] FAILED`, {
      status,
      message: err?.message || String(err),
      dataShort: typeof data === "string" ? data.slice(0, 400) : data ? "json" : null,
    });

    return res.status(502).json({
      error: "Upstream start failed (legacy)",
      upstream_status: status,
      details: dbg ? data : null,
      request_id: requestId,
    });
  }
});

/* ---------------------------------------------------------
   RESULTS – /api/flights/results (LEGACY -> OFFERS FORMAT)
--------------------------------------------------------- */
router.post("/flights/results", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });

    const { search_id } = req.body || {};
    const sid = String(search_id || "").trim();
    if (!sid) return res.status(400).json({ error: "Mangler search_id", request_id: requestId });

    const cached = flightSearchCache.get(sid);
    if (!cached?.uuid) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: requestId });
    }

    const url = `${TP_LEGACY_RESULTS_URL}?uuid=${encodeURIComponent(cached.uuid)}`;

    if (dbg) console.log(`[TP][results][${requestId}] GET`, { url });

    const r = await axios.get(url, {
      headers: { Accept: "application/json" },
      timeout: RESULTS_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const data = r.data || {};
    const isOver = inferIsOver(data);
    const lastTs = inferLastTs(data, 0);

    const { offers, meta } = buildOffersFromTpResults(data, sid);

    // cache siste OK raw + offers (for timeout fallback)
    flightSearchCache.set(sid, {
      ...cached,
      last_ok_results: data,
      last_ok_at: Date.now(),
      last_ok_offers: offers,
      last_ok_meta: meta,
      last_ok_ts: lastTs,
      last_ok_is_over: isOver,
    });

    if (dbg) {
      console.log(`[TP][results][${requestId}] upstream`, {
        status: r.status,
        isOver,
        lastTs,
        offers: offers.length,
        meta,
      });
    }

    // ✅ Dette er formatet appen forventer
    return res.json({
      ok: true,
      is_over: isOver,
      last_update_timestamp: lastTs,
      offers,
      request_id: requestId,
      meta: dbg ? meta : undefined,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;
    const isTimeout = err?.code === "ECONNABORTED" || String(err?.message || "").toLowerCase().includes("timeout");

    // Timeout: returner siste OK offers hvis vi har
    if (isTimeout) {
      try {
        const sid = String(req.body?.search_id || "").trim();
        const cached = sid ? flightSearchCache.get(sid) : null;

        if (cached?.last_ok_offers) {
          console.error(`[TP][results][${requestId}] TIMEOUT -> cached offers`, {
            offers: cached.last_ok_offers.length,
            ageMs: Date.now() - (cached.last_ok_at || Date.now()),
          });

          return res.json({
            ok: true,
            is_over: !!cached.last_ok_is_over,
            last_update_timestamp: Number(cached.last_ok_ts || 0),
            offers: cached.last_ok_offers,
            is_cached: true,
            request_id: requestId,
          });
        }
      } catch {
        // ignore
      }
    }

    console.error(`[TP][results][${requestId}] FAILED`, {
      status,
      message: err?.message || String(err),
      dataShort: typeof data === "string" ? data.slice(0, 400) : data ? "json" : null,
      code: err?.code || null,
    });

    return res.status(502).json({
      error: "Upstream results failed (legacy)",
      upstream_status: status,
      details: dbg ? data : null,
      request_id: requestId,
    });
  }
});

export default router;
