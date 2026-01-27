// routes/flights.js (ESM) — Alternativ A (tickets-api affiliate) ✅
// - START:  https://tickets-api.travelpayouts.com/search/affiliate/start
// - RESULTS: POST {results_url}/search/affiliate/results   (støtter 304)
// - CLICK:  GET  {results_url}/searches/{search_id}/clicks/{proposal_id}
// - LOCATIONS er i egen route hos deg (routes/locations.js) så ikke her.

import express from "express";
import axios from "axios";

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeSignature } from "../services/travelpayouts/tpSign.js";
import { flightSearchCache } from "../services/travelpayouts/flightsCache.js";

const router = express.Router();

const TP_AFFILIATE_START_URL =
  "https://tickets-api.travelpayouts.com/search/affiliate/start";

const START_TIMEOUT_MS = 20000;
const RESULTS_TIMEOUT_MS = 25000;
const CLICK_TIMEOUT_MS = 20000;

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

function normalizeAbsoluteUrl(u) {
  if (!u) return "";
  let s = String(u).trim();

  // fjern trailing slashes
  s = s.replace(/\/+$/, "");

  // allerede absolutt
  if (/^https?:\/\//i.test(s)) return s;

  // //example.com/...
  if (s.startsWith("//")) return ("https:" + s).replace(/\/+$/, "");

  // hvis den starter med / så er det en path – ikke ok her
  if (s.startsWith("/")) return "";

  // host uten scheme -> legg på https://
  return ("https://" + s).replace(/\/+$/, "");
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
    data?.search_params?.currency_code ||
    data?.search_params?.currency ||
    data?.currency_code ||
    data?.currency ||
    "NOK";
  return toUpper(c || "NOK");
}

function parseDurationToMinutes(raw) {
  if (raw == null || raw === "") return null;

  // number: minutes or seconds
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristikk: veldig store tall er ofte sekunder
    return raw > 10000 ? Math.round(raw / 60) : Math.round(raw);
  }

  const s = String(raw).trim();
  if (!s) return null;

  // "HH:MM" eller "H:MM"
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
  }

  // ISO-8601 "PT4H50M", "PT55M", "PT1H"
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) {
    const h = Number(iso[1] || 0);
    const m = Number(iso[2] || 0);
    const sec = Number(iso[3] || 0);
    if ([h, m, sec].every(Number.isFinite)) return h * 60 + m + Math.round(sec / 60);
  }

  // plain number in string
  const n = Number(s.replace(",", "."));
  if (Number.isFinite(n)) {
    return n > 10000 ? Math.round(n / 60) : Math.round(n);
  }

  return null;
}

function minutesBetween(dep, arr) {
  if (!dep || !arr) return null;
  const t1 = Date.parse(dep);
  const t2 = Date.parse(arr);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;

  let diffMin = Math.round((t2 - t1) / 60000);

  // Hvis ankomst “dagen etter” men uten dato/zone som parse’t rart:
  // tillat wrap innen 24t
  if (diffMin < 0 && diffMin > -24 * 60) diffMin += 24 * 60;

  return diffMin >= 0 ? diffMin : null;
}

/**
 * Normaliser tickets-api affiliate results -> appens offers-format.
 * Forventer data.tickets[] + data.flight_legs[] (som før).
 * Returnerer { offers, meta }.
 */
function buildOffersFromTpResults(data, searchId) {
  const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
  const legsArr = Array.isArray(data?.flight_legs) ? data.flight_legs : [];

  if (!tickets.length || !legsArr.length) {
    return {
      offers: [],
      meta: {
        schema: "tickets+flight_legs(empty)",
        tickets: tickets.length,
        legs: legsArr.length,
      },
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

    // 1) id
    const byId = legsById.get(String(ref));
    if (byId) return byId;

    // 2) index
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
      "departure_datetime",
      "time_departure",
      "departure_at",
      "local_departure",
      "depart_at",
      "departure_time",
  ]);

  const legArr = (leg) =>
    pick(leg, [
      "local_arrival_date_time",
      "arrival_datetime",
      "time_arrival",
      "arrival_at",
      "local_arrival",
      "arrive_at",
      "arrival_time",
  ]);
  
  const legDurationMins = (leg) => {
    const raw = pick(leg, [
      "duration",
      "duration_mins",
      "duration_minutes",
      "travel_time",
      "flight_time",
      "duration_min",
      "duration_sec",
      "duration_seconds",
    ]);

    // Prøv parse av flere formater
    let mins = parseDurationToMinutes(raw);

    // Noen API’er har eksplisitt sekunderfelt
    if (mins == null) {
      const sec = pick(leg, ["duration_sec", "duration_seconds"]);
      const m2 = parseDurationToMinutes(sec);
      if (m2 != null) mins = m2;
    }

    // Fallback: regn ut fra avgang/ankomst på leg
    if (mins == null) {
      const d = legDep(leg);
      const a = legArr(leg);
      mins = minutesBetween(d, a);
    }

    return mins;
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

    function parseDateMs(v) {
      if (!v) return null;
      const ms = Date.parse(String(v));
      return Number.isFinite(ms) ? ms : null;
    }

    function computeTotalDurationMinsFromLegs(legs) {
      if (!legs?.length) return null;

      const dep0 = parseDateMs(legDep(legs[0]));
      const arrLast = parseDateMs(legArr(legs[legs.length - 1]));

      // 1) Beste: første avgang -> siste ankomst (inkl. layovers)
      if (dep0 != null && arrLast != null) {
        let diffMin = Math.round((arrLast - dep0) / 60000);
        if (diffMin < 0 && diffMin > -24 * 60) diffMin += 24 * 60; // mild wrap
        return diffMin >= 0 ? diffMin : null;
      }

      // 2) Neste: summer flytid + layover gaps når vi kan
      let total = 0;
      let hasAny = false;

      for (let i = 0; i < legs.length; i++) {
        const lm = legDurationMins(legs[i]);
        if (lm != null) {
          total += lm;
          hasAny = true;
        }
        if (i < legs.length - 1) {
          const a = parseDateMs(legArr(legs[i]));
          const d = parseDateMs(legDep(legs[i + 1]));
          if (a != null && d != null) {
            let gap = Math.round((d - a) / 60000);
            if (gap < 0 && gap > -24 * 60) gap += 24 * 60;
            if (gap > 0) {
              total += gap;
              hasAny = true;
            }
          }
        }
      }

      return hasAny ? total : null;
    }
      
    // Total varighet inkl. layovers
    let durationSum = legs.length > 0 ? computeTotalDurationMinsFromLegs(legs) : null;

    // Ticket-level fallback (kan ofte være total inkl. layovers)
    if (durationSum == null) {
      durationSum =
        parseDurationToMinutes(t?.total_duration) ??
        parseDurationToMinutes(t?.duration) ??
        parseDurationToMinutes(t?.travel_time) ??
        null;
    }
      
    // Hvis vi fortsatt ikke har varighet: regn ut fra første dep til siste arr
    if (durationSum == null || durationSum === 0) {
      const d0 = dep; // dep du allerede har plukket ut
      const a0 = arr; // arr du allerede har plukket ut
      const m = minutesBetween(d0, a0);
      if (m != null) durationSum = m;
    }
      
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
  return {
    offers,
    meta: {
      schema: "tickets+flight_legs",
      tickets: tickets.length,
      legs: legsArr.length,
    },
  };
}

/* ---------------------------------------------------------
   START – /api/flights/start (AFFILIATE tickets-api)
--------------------------------------------------------- */
router.post("/flights/start", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) {
      return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });
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
        request_id: requestId,
      });
    }
    if (directions.some((d) => d.origin === d.destination)) {
      return res.status(400).json({
        error: "origin og destination kan ikke være like",
        request_id: requestId,
      });
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

    // tickets-api affiliate payload
    const payload = {
      marker: tp.marker,
      locale: body.locale || "no",
      currency_code: toUpper(body.currency || "NOK"),
      market_code: body.market_code || "NO",
      search_params: {
        trip_class: toUpper(body.trip_class || "Y"),
        passengers: { adults, children, infants },
        directions,
      },
    };

    const signature = makeSignature(tp.token, payload);

    if (dbg) {
      console.log(`[TP][start][${requestId}] cfg`, {
        hasToken: !!tp.token,
        hasMarker: !!tp.marker,
        realHost: tp.realHost,
        tokenPreview: safe(tp.token, 4),
        markerPreview: safe(tp.marker, 3),
      });
      console.log(`[TP][start][${requestId}] payload`, {
        market_code: payload.market_code,
        currency_code: payload.currency_code,
        locale: payload.locale,
        trip_class: payload.search_params.trip_class,
        passengers: payload.search_params.passengers,
        directions: payload.search_params.directions,
        signaturePreview: safe(signature, 6),
      });
    }

    const r = await axios.post(
      TP_AFFILIATE_START_URL,
      { ...payload, signature },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: START_TIMEOUT_MS,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );

    const searchId = r.data?.search_id ?? null;
    const resultsUrl = r.data?.results_url ?? null;

    if (dbg) {
      console.log(`[TP][start][${requestId}] upstream`, {
        status: r.status,
        search_id: searchId ? safe(searchId, 8) : null,
        results_url: resultsUrl ? String(resultsUrl).slice(0, 80) : null,
      });
    }

    if (!searchId || !resultsUrl) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler search_id/results_url)",
        details: dbg ? r.data : null,
        request_id: requestId,
      });
    }

    const base = normalizeAbsoluteUrl(resultsUrl);
    if (!base) {
      return res.status(502).json({
        error: "Ugyldig results_url fra Travelpayouts (ikke absolutt URL)",
        details: dbg ? { results_url: resultsUrl } : null,
        request_id: requestId,
      });
    }

    flightSearchCache.set(String(searchId), {
      mode: "affiliate",
      search_id: String(searchId),
      results_url: base, // ✅ viktig for results + click
      created_at: Date.now(),
      last_ok_at: null,
      last_ok_offers: null,
      last_ok_ts: 0,
      last_ok_is_over: false,
      offer_to_tp_proposal: null,
    });

    return res.json({
      ok: true,
      search_id: String(searchId),
      request_id: requestId,
      // (valgfritt) results_url: resultsUrl,  // kan være nyttig til debug
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
      error: "Upstream start failed (affiliate)",
      upstream_status: status,
      details: dbgEnabled() ? data : null,
      request_id: requestId,
    });
  }
});

/* ---------------------------------------------------------
   RESULTS – /api/flights/results (AFFILIATE -> OFFERS)
--------------------------------------------------------- */
router.post("/flights/results", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });

    const { search_id, last_update_timestamp = 0 } = req.body || {};
    const sid = String(search_id || "").trim();
    const tsIn = Number(last_update_timestamp) || 0;

    if (!sid) return res.status(400).json({ error: "Mangler search_id", request_id: requestId });

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: requestId });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({
        error: "Cached results_url er ugyldig",
        request_id: requestId,
      });
    }

    const resultsUrl = new URL("/search/affiliate/results", base).toString();

    // payload for affiliate results
    const payload = { marker: tp.marker, search_id: sid, last_update_timestamp: tsIn };
    const signature = makeSignature(tp.token, payload);

    if (dbg) console.log(`[TP][results][${requestId}] POST`, { resultsUrl, sid, tsIn });

    const r = await axios.post(
      resultsUrl,
      { ...payload, signature },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: RESULTS_TIMEOUT_MS,
        validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
      }
    );

    // 304 = ingen endring. IKKE overskriv offers i appen.
    if (r.status === 304) {
      return res.json({
        ok: true,
        is_over: false,
        last_update_timestamp: tsIn,
        offers: null,
        request_id: requestId,
        meta: dbg ? { schema: "304_no_change" } : undefined,
      });
    }

    const data = r.data || {};
    const isOver = inferIsOver(data);
    const tpRawTs = inferLastTs(data, 0);
    const tsOut = Math.max(tsIn, tpRawTs || 0);

    const { offers, meta } = buildOffersFromTpResults(data, sid);

    // cache mapping offer_id -> proposal_id (for click fallback)
    const map = {};
    for (const o of offers) if (o.offer_id && o.tp_proposal_id) map[o.offer_id] = o.tp_proposal_id;

    flightSearchCache.set(sid, {
      ...cached,
      last_ok_at: Date.now(),
      last_ok_offers: offers,
      last_ok_ts: tsOut,
      last_ok_is_over: isOver,
      offer_to_tp_proposal: map,
    });

    if (dbg) {
      console.log(`[TP][results][${requestId}] upstream`, {
        status: r.status,
        isOver,
        tsOut,
        offers: offers.length,
        meta,
      });
    }

    return res.json({
      ok: true,
      is_over: isOver,
      last_update_timestamp: tsOut,
      offers,
      request_id: requestId,
      meta: dbg ? meta : undefined,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;
    const isTimeout =
      err?.code === "ECONNABORTED" ||
      String(err?.message || "").toLowerCase().includes("timeout");

    // Timeout -> return cached offers hvis vi har
    if (isTimeout) {
      try {
        const sid = String(req.body?.search_id || "").trim();
        const cached = sid ? flightSearchCache.get(sid) : null;

        if (cached?.last_ok_offers) {
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
      error: "Upstream results failed (affiliate)",
      upstream_status: status,
      details: dbgEnabled() ? data : null,
      request_id: requestId,
    });
  }
});

/* ---------------------------------------------------------
   CLICK – /api/flights/click (AFFILIATE new click endpoint)
--------------------------------------------------------- */
router.post("/flights/click", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });

    const { search_id, offer_id, tp_proposal_id } = req.body || {};
    const sid = String(search_id || "").trim();
    const offerId = String(offer_id || "").trim();
    const directProposalId = tp_proposal_id != null ? String(tp_proposal_id).trim() : "";

    if (!sid) return res.status(400).json({ error: "Mangler search_id", request_id: requestId });
    if (!directProposalId && !offerId) {
      return res.status(400).json({ error: "Mangler tp_proposal_id eller offer_id", request_id: requestId });
    }

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: requestId });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({ error: "Cached results_url er ugyldig", request_id: requestId });
    }

    // resolve proposal_id
    let proposalId = directProposalId;
    if (!proposalId && offerId) {
      proposalId = cached?.offer_to_tp_proposal?.[offerId] || "";
    }

    if (!proposalId) {
      return res.status(409).json({
        error: "Mangler proposal_id (send tp_proposal_id fra app eller poll results først).",
        request_id: requestId,
      });
    }

    const clickUrl = new URL(
      `/searches/${encodeURIComponent(sid)}/clicks/${encodeURIComponent(String(proposalId))}`,
      base
    ).toString();

    const headers = {
      Accept: "application/json",
      "X-Affiliate-Marker": tp.marker,
      "X-Marker": tp.marker,
      marker: tp.marker,
    };

    if (dbg) console.log(`[TP][click][${requestId}] GET`, { clickUrl, sid, proposalId: safe(proposalId, 6) });

    const cr = await axios.get(clickUrl, {
      headers,
      timeout: CLICK_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 400,
      maxRedirects: 0,
    });

    const pickUrlFromObj = (o) =>
      (o &&
        (o.url ||
          o.click_url ||
          o.clickUrl ||
          o.redirect_url ||
          o.redirectUrl ||
          o.deeplink ||
          o.deep_link ||
          o.deepLink ||
          o.link ||
          o.result_url ||
          o.resultUrl)) ||
      null;

    const url = pickUrlFromObj(cr?.data);

    if (!url) {
      return res.status(502).json({
        error: "TP click manglet url (uventet respons)",
        details: dbg ? { status: cr.status, data: cr.data } : null,
        request_id: requestId,
      });
    }

    return res.json({ ok: true, url, request_id: requestId });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;

    console.error(`[TP][click][${requestId}] FAILED`, {
      status,
      message: err?.message || String(err),
      dataShort: typeof data === "string" ? data.slice(0, 400) : data ? "json" : null,
    });

    return res.status(502).json({
      error: "Upstream click failed (affiliate)",
      upstream_status: status,
      details: dbgEnabled() ? data : null,
      request_id: requestId,
    });
  }
});

export default router;
