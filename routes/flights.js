// routes/flights.js (ESM)

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
  returnimg: "https://images.unsplash.com/photo-1582381504580-70c3e2bca97d?auto=format&fit=crop&w=800&q=60"
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

/* =========================================================
   RESULT PARSERS
   TP kan returnere (minst) 2 ulike shapes:

   A) "Old/legacy": JSON ARRAY av proposals/tickets
      - ofte: [ { ...ticket... }, { ...ticket... }, ... ]
      - mens search bygges: ofte OBJECT med bare { search_id: "..." }
        eller ARRAY med 1 element som kun har search_id.

   B) "New-ish": OBJECT med tickets + flight_legs
========================================================= */

// --------- NEW-ish parser (tickets + flight_legs) ---------

function pickPriceFromProposalNew(p) {
  const c = p?.price ?? p?.unified_price ?? p?.total_price ?? p?.amount ?? null;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string") return num(c);
  if (c && typeof c === "object") return num(c.amount ?? c.value ?? c.price ?? c.total);
  return null;
}

function pickCurrencyNew(p, t, data) {
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

function inferIsOverFromObject(data) {
  if (!data) return false;
  if (typeof data.is_over === "boolean") return data.is_over;
  const st = String(data.status || data.search_status || data.state || "").toLowerCase();
  return st === "done" || st === "completed" || st === "complete" || st === "finished";
}

function inferLastTsFromObject(data, fallback = 0) {
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

function buildOffersFromTpObjectNew(data, searchId) {
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
    const code =
      (typeof obj === "object" ? pick(obj, ["iata", "iata_code", "code", "id", "carrier_code", "airline_code"]) : null) ||
      null;
    return toUpper(code || "");
  };

  const legFlightNo = (leg) => {
    const direct = pick(leg, ["flight_number", "flight_no", "flightNumber", "flight_num", "number"]);
    if (direct != null && direct !== "") return toUpper(String(direct));
    const obj = leg?.flight || leg?.flight_number_obj || null;
    const n = typeof obj === "object" ? pick(obj, ["number", "flight_number", "flightNo", "no"]) : null;
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

      const price = pickPriceFromProposalNew(p);
      const currency = pickCurrencyNew(p, t, data);

      offers.push({
        offer_id,
        tp_proposal_id: tp_proposal_id != null ? String(tp_proposal_id) : null,
        // for /click in NEW-ish mode (om du senere støtter den)
        click_mode: "new",
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
    meta: { schema: "tickets+flight_legs", tickets: tickets.length, legs: legsArr.length },
  };
}

// --------- LEGACY parser (ARRAY av proposals) ---------

function isNotReadyLegacyArray(arr) {
  if (!Array.isArray(arr) || arr.length !== 1) return false;
  const only = arr[0];
  if (!only || typeof only !== "object") return false;
  const keys = Object.keys(only);
  return keys.length === 1 && keys[0] === "search_id";
}

function extractBestTermFromLegacyProposal(p) {
  // legacy: p.terms = { GATE: { price, currency, url, ... }, ... }
  const terms = p?.terms && typeof p.terms === "object" ? p.terms : null;
  if (!terms) return null;

  let best = null;
  for (const gate of Object.keys(terms)) {
    const t = terms[gate];
    if (!t || typeof t !== "object") continue;

    const price = num(t.price ?? t.unified_price ?? t.value ?? t.amount);
    if (price == null) continue;

    const currency = toUpper(t.currency ?? t.currency_code ?? t.curr ?? "NOK");
    if (!best || price < best.price) {
      best = { gate, price, currency, term: t };
    }
  }
  return best;
}

function buildOffersFromTpLegacyArray(arr, searchId) {
  // Vi lager et offer per proposal (billigste term per proposal).
  // Dep/arr/duration kan variere i schema; vi fyller best-effort.
  const offers = [];
  let counter = 0;

  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    if (p.search_id && Object.keys(p).length === 1) continue;

    const best = extractBestTermFromLegacyProposal(p);
    if (!best) continue;

    // Route / tider (best-effort)
    const seg0 = Array.isArray(p?.segments) ? p.segments[0] : null;

    const origin = toUpper(
      pick(seg0, ["origin", "from", "origin_iata", "origin_code"]) || pick(p, ["origin", "from"]) || ""
    );
    const destination = toUpper(
      pick(seg0, ["destination", "to", "destination_iata", "destination_code"]) || pick(p, ["destination", "to"]) || ""
    );
    const routeText = origin && destination ? `${origin} → ${destination}` : "";

    // Noen legacy-responser har tider på flights / segments; vi prøver noen vanlige felter
    const dep = pick(seg0, ["departure_time", "depart_time", "departure_at", "local_departure", "time_departure"]);
    const arrTimeRaw = pick(seg0, ["arrival_time", "arrive_time", "arrival_at", "local_arrival", "time_arrival"]);

    const depTime = fmtTimeHHMM(dep);
    const arrTime = fmtTimeHHMM(arrTimeRaw);

    const durationMins =
      num(p?.duration) ??
      num(seg0?.duration) ??
      num(seg0?.duration_mins) ??
      num(seg0?.duration_minutes) ??
      null;

    const durationText = durationMins != null ? fmtDurationMins(durationMins) : "";

    const stops =
      num(p?.transfers) ??
      (Array.isArray(seg0?.transfers) ? seg0.transfers.length : null) ??
      null;

    const stopsText = stops == null ? "" : stops === 0 ? "Direkte" : `${stops} stopp`;

    const offer_id = `${String(searchId)}:${counter}`;
    counter += 1;

    offers.push({
      offer_id,
      // Bruk gate som "tp_proposal_id" (appen sender denne videre til /click)
      tp_proposal_id: String(best.gate),
      click_mode: "legacy",
      // NB: Vi trenger "terms" når vi skal generere click-url (terms.url.json)
      tp_terms: String(best.gate),

      price: best.price,
      currency: best.currency,
      depTime,
      arrTime,
      durationText,
      routeText,
      stopsText,
      airlinesText: "",
      flightNosText: "",
      agentText: String(best.gate),
    });
  }

  offers.sort((a, b) => (a.price ?? 1e18) - (b.price ?? 1e18));
  return { offers, meta: { schema: "legacy-array", proposals: offers.length } };
}

/* =========================================================
   Helpers for progress timestamp (for app polling)
========================================================= */

function computeProgressTs({ upstreamLastTs, offersCount, cached }) {
  // Hvis upstream gir timestamp: bruk den.
  if (typeof upstreamLastTs === "number" && Number.isFinite(upstreamLastTs) && upstreamLastTs > 0) {
    return upstreamLastTs;
  }

  // Ellers: lag en stabil ts som endrer seg når vi ser "fremdrift".
  const prevCount = Number(cached?.last_offer_count || 0);
  const prevTs = Number(cached?.last_ok_ts || 0);

  if (offersCount > prevCount) {
    return Date.now(); // gir tydelig endring -> appen fortsetter polling
  }

  // Ingen nye offers: hold ts stabil (så appen kan telle "noChange")
  return prevTs || 0;
}

/* =========================================================
   START – /api/flights/start (LEGACY)
========================================================= */
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
      return res.status(400).json({
        error: "Minst ett segment kreves (origin, destination, date)",
        request_id: requestId,
      });
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
      host: tp.realHost, // f.eks. "podtech.no"
      user_ip:
        String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.ip || "")
          .split(",")[0]
          .trim() || "127.0.0.1",
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

    // ✅ FIX: logg riktig variabel (r), ikke "response"
    if (dbg) {
      console.log(`[TP][start][${requestId}] response`, {
        status: r.status,
        keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
        search_id: r.data?.search_id,
        results_url: r.data?.results_url,
      });
    }

    const uuid = r.data?.uuid ?? r.data?.search_id ?? r.data?.searchId ?? null;

    if (!uuid) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler uuid/search_id)",
        details: dbg ? r.data : null,
        request_id: requestId,
      });
    }

    // cache for polling
    flightSearchCache.set(String(uuid), {
      mode: "legacy",
      uuid: String(uuid),
      created_at: Date.now(),
      last_ok_results: null,
      last_ok_at: null,
      last_ok_ts: 0,
      last_offer_count: 0,
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

/* =========================================================
   RESULTS – /api/flights/results
   - støtter både ARRAY (legacy) og OBJECT (new-ish)
========================================================= */
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
      // ikke strengt nødvendig, men ok:
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const data = r.data;

    // --------- CASE 1: legacy ARRAY ---------
    if (Array.isArray(data)) {
      const notReady = isNotReadyLegacyArray(data);
      if (dbg) {
        console.log(`[TP][results][${requestId}] legacy array`, {
          len: data.length,
          notReady,
          sampleKeys: data[0] && typeof data[0] === "object" ? Object.keys(data[0]) : null,
        });
      }

      const { offers, meta } = notReady
        ? { offers: [], meta: { schema: "legacy-array(not-ready)" } }
        : buildOffersFromTpLegacyArray(data, sid);

      const progressTs = computeProgressTs({
        upstreamLastTs: 0,
        offersCount: offers.length,
        cached,
      });

      flightSearchCache.set(sid, {
        ...cached,
        last_ok_results: data,
        last_ok_at: Date.now(),
        last_ok_offers: offers,
        last_ok_meta: meta,
        last_ok_ts: progressTs,
        last_offer_count: offers.length,
        last_ok_is_over: false, // legacy har ikke "is_over"; du poller til du stopper selv
      });

      return res.json({
        ok: true,
        is_over: false,
        last_update_timestamp: progressTs,
        offers,
        request_id: requestId,
        meta: dbg ? meta : undefined,
      });
    }

    // --------- CASE 2: legacy "not ready" OBJECT { search_id: "..." } ---------
    if (data && typeof data === "object" && data.search_id && Object.keys(data).length === 1) {
      if (dbg) console.log(`[TP][results][${requestId}] legacy not-ready object`, { search_id: data.search_id });

      // hold ts stabil så appen ikke tror den får fremdrift
      const progressTs = Number(cached?.last_ok_ts || 0);

      return res.json({
        ok: true,
        is_over: false,
        last_update_timestamp: progressTs,
        offers: [],
        request_id: requestId,
        meta: dbg ? { schema: "legacy-object(not-ready)" } : undefined,
      });
    }

    // --------- CASE 3: new-ish OBJECT (tickets + flight_legs) ---------
    const obj = data && typeof data === "object" ? data : {};
    const isOver = inferIsOverFromObject(obj);
    const upstreamTs = inferLastTsFromObject(obj, 0);

    const { offers, meta } = buildOffersFromTpObjectNew(obj, sid);

    const progressTs = computeProgressTs({
      upstreamLastTs: upstreamTs,
      offersCount: offers.length,
      cached,
    });

    flightSearchCache.set(sid, {
      ...cached,
      last_ok_results: obj,
      last_ok_at: Date.now(),
      last_ok_offers: offers,
      last_ok_meta: meta,
      last_ok_ts: progressTs,
      last_offer_count: offers.length,
      last_ok_is_over: isOver,
    });

    if (dbg) {
      console.log(`[TP][results][${requestId}] new-ish object`, {
        status: r.status,
        isOver,
        upstreamTs,
        progressTs,
        offers: offers.length,
        meta,
        topKeys: obj && typeof obj === "object" ? Object.keys(obj).slice(0, 20) : null,
      });
    }

    return res.json({
      ok: true,
      is_over: isOver,
      last_update_timestamp: progressTs,
      offers,
      request_id: requestId,
      meta: dbg ? meta : undefined,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;
    const isTimeout =
      err?.code === "ECONNABORTED" || String(err?.message || "").toLowerCase().includes("timeout");

    // Timeout: returner siste OK offers hvis vi har
    if (isTimeout) {
      try {
        const sid = String(req.body?.search_id || "").trim();
        const cached = sid ? flightSearchCache.get(sid) : null;

        if (cached?.last_ok_offers) {
          console.error(`[TP][results][${rid}] TIMEOUT -> cached offers`, {
            offers: cached.last_ok_offers.length,
            ageMs: Date.now() - (cached.last_ok_at || Date.now()),
          });

          return res.json({
            ok: true,
            is_over: !!cached.last_ok_is_over,
            last_update_timestamp: Number(cached.last_ok_ts || 0),
            offers: cached.last_ok_offers,
            is_cached: true,
            request_id: rid,
          });
        }
      } catch {
        // ignore
      }
    }

    console.error(`[TP][results][${rid}] FAILED`, {
      status,
      message: err?.message || String(err),
      dataShort: typeof data === "string" ? data.slice(0, 400) : data ? "json" : null,
      code: err?.code || null,
    });

    return res.status(502).json({
      error: "Upstream results failed",
      upstream_status: status,
      details: dbgEnabled() ? data : null,
      request_id: rid,
    });
  }
});

/* =========================================================
   CLICK – /api/flights/click
   IMPORTANT: skal kun kalles ved brukerklikk (du gjør det riktig i appen)
   Legacy docs: /v1/flight_searches/<search_id>/clicks/terms.url.json?marker=<marker>
========================================================= */
router.post("/flights/click", async (req, res) => {
  const requestId = rid();
  const dbg = dbgEnabled();

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error, request_id: requestId });

    const body = req.body || {};
    const sid = String(body.search_id || "").trim();
    const offerId = String(body.offer_id || "").trim();

    if (!sid) return res.status(400).json({ error: "Mangler search_id", request_id: requestId });
    if (!offerId) return res.status(400).json({ error: "Mangler offer_id", request_id: requestId });

    const cached = flightSearchCache.get(sid);
    if (!cached?.uuid) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt).", request_id: requestId });
    }

    // Finn offer i cache (vi trenger tp_terms / gate for legacy)
    const offers = Array.isArray(cached?.last_ok_offers) ? cached.last_ok_offers : [];
    const found = offers.find((o) => String(o.offer_id) === offerId) || null;

    // Fallback: app sender tp_proposal_id; for legacy bruker vi gate=tp_proposal_id
    const gate = String(found?.tp_terms || found?.tp_proposal_id || body.tp_proposal_id || "").trim();
    if (!gate) {
      return res.status(400).json({
        error: "Mangler gate/terms for click",
        request_id: requestId,
      });
    }

    // Legacy click url endpoint (terms.url.json)
    // NB: endpoint-navn er slik i legacy docs.
    const clickUrl = `https://api.travelpayouts.com/v1/flight_searches/${encodeURIComponent(
      cached.uuid
    )}/clicks/terms.url.json?marker=${encodeURIComponent(tp.marker)}`;

    // Legacy payload: { terms: "<GATE>" } (ofte gate-kode, ref. docs)
    const rr = await axios.post(
      clickUrl,
      { terms: gate },
      { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 20000 }
    );

    const url =
      rr?.data?.url ||
      rr?.data?.terms_url ||
      rr?.data?.redirect_url ||
      rr?.data?.data?.url ||
      null;

    if (dbg) {
      console.log(`[TP][click][${requestId}]`, {
        status: rr.status,
        gate,
        gotUrl: !!url,
        keys: rr.data && typeof rr.data === "object" ? Object.keys(rr.data) : null,
      });
    }

    if (!url) {
      return res.status(502).json({
        error: "Ugyldig click-respons fra Travelpayouts (mangler url)",
        details: dbg ? rr.data : null,
        request_id: requestId,
      });
    }

    return res.json({
      ok: true,
      url,
      request_id: requestId,
    });
  } catch (err) {
    const status = err?.response?.status ?? null;
    const data = err?.response?.data ?? null;

    console.error(`[TP][click][${requestId}] FAILED`, {
      status,
      message: err?.message || String(err),
      dataShort: typeof data === "string" ? data.slice(0, 400) : data ? "json" : null,
    });

    return res.status(502).json({
      error: "Upstream click failed",
      upstream_status: status,
      details: dbgEnabled() ? data : null,
      request_id: requestId,
    });
  }
});

export default router;
