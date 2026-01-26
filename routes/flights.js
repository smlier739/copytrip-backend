// backend/routes/flights.js (ESM)

import express from "express";
import axios from "axios";

import { getTpConfig, assertTpConfigured } from "../services/travelpayouts/tpConfig.js";
import { makeHeaders, makeSignature } from "../services/travelpayouts/tpSign.js";
import { normalizeAbsoluteUrl } from "../services/travelpayouts/tpHttp.js";
import { flightSearchCache } from "../services/travelpayouts/flightsCache.js";

const router = express.Router();

// Travelpayouts start endpoint (fast)
const TP_START_URL = "https://api.travelpayouts.com/flight_search/v1/start";

/* ------------------------- Small helpers ------------------------- */

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

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
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
    "NOK";
  return toUpper(c || "NOK");
}

function pickUrlFromObj(o) {
  return (
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
    null
  );
}

// click-respons kan være string, eller objekt med url et eller annet sted
function normalizeClickUrl(respData, axiosHeaders) {
  // 1) Hvis TP svarer med et objekt med url
  const fromObj = pickUrlFromObj(respData);
  if (fromObj) return fromObj;

  // 2) Hvis TP svarer med ren string
  if (typeof respData === "string" && respData.trim()) return respData.trim();

  // 3) Noen click-endepunkt svarer med Location header (redirect uten å følge)
  const loc = axiosHeaders?.location || axiosHeaders?.Location || null;
  if (loc) return String(loc);

  return null;
}

/* ------------------------- START – /api/flights/start ------------------------- */

router.post("/flights/start", async (req, res) => {
  const DEBUG =
    String(process.env.FLIGHTS_DEBUG || "").toLowerCase() === "1" ||
    process.env.NODE_ENV !== "production";

  // Liten helper: mask token i logger
  const mask = (s) => {
    const x = String(s || "");
    if (!x) return "";
    if (x.length <= 8) return "***";
    return `${x.slice(0, 4)}…${x.slice(-4)}`;
  };

  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) {
      if (DEBUG) {
        console.error("🧪 TP CONFIG INVALID:", okCfg);
        console.error("🧪 TP CONFIG SNAPSHOT:", {
          token: mask(tp?.token),
          marker: tp?.marker || null,
          realHost: tp?.realHost || null,
          lang: tp?.lang || null,
        });
      }
      return res.status(okCfg.status).json({ error: okCfg.error, debug: DEBUG ? okCfg : undefined });
    }

    const body = req.body || {};
    const segments = Array.isArray(body.segments) ? body.segments : [];

    const directions = segments
      .map((s) => ({
        origin: toUpper(String(s?.origin || "").trim()),
        destination: toUpper(String(s?.destination || "").trim()),
        date: String(s?.date || "").trim(), // YYYY-MM-DD
      }))
      .filter((d) => d.origin && d.destination && d.date);

    if (!directions.length) {
      return res.status(400).json({
        error: "Minst ett segment kreves (origin, destination, date)",
      });
    }

    if (directions.some((d) => d.origin === d.destination)) {
      return res.status(400).json({
        error: "origin og destination kan ikke være like",
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
      return res.status(400).json({ error: "Ugyldig passasjer-oppsett" });
    }

    const payload = {
      marker: tp.marker,
      locale: body.locale || "no",
      currency_code: body.currency || "NOK",
      market_code: body.market_code || "NO",
      search_params: {
        trip_class: toUpper(body.trip_class || "Y"),
        passengers: { adults, children, infants },
        directions,
      },
    };

    // makeSignature(token, payload)
    const signature = makeSignature(tp.token, payload);

    // Bygg headers én gang (og logg dem)
    const headers = makeHeaders(req, signature, tp);

    if (DEBUG) {
      console.log("🧪 /flights/start DEBUG");
      console.log("🧪 TP:", {
        token: mask(tp.token),
        marker: tp.marker,
        realHost: tp.realHost,
        lang: tp.lang,
      });
      console.log("🧪 TP_START_URL:", TP_START_URL);
      console.log("🧪 SIGNATURE:", signature);
      console.log("🧪 HEADERS:", {
        ...headers,
        // vis trygt hva vi sender
        "x-affiliate-user-id": mask(headers["x-affiliate-user-id"]),
      });
      console.log("🧪 PAYLOAD:", JSON.stringify(payload, null, 2));
    }

    const response = await axios.post(
      TP_START_URL,
      { ...payload, signature },
      {
        headers,
        timeout: 20000,
        // nyttig når TP svarer med 4xx og axios ellers kaster
        validateStatus: (status) => status >= 200 && status < 300,
      }
    );

    if (DEBUG) {
      console.log("🧪 TP RESPONSE STATUS:", response.status);
      console.log("🧪 TP RESPONSE DATA:", JSON.stringify(response.data || null, null, 2));
    }

    const searchId = response.data?.search_id;
    const resultsUrl = response.data?.results_url;

    if (!searchId || !resultsUrl) {
      return res.status(502).json({
        error: "Ugyldig svar fra Travelpayouts (mangler search_id/results_url)",
        details: response.data || null,
      });
    }

    const normalizedResultsUrl = normalizeAbsoluteUrl(resultsUrl);
    if (!normalizedResultsUrl) {
      return res.status(502).json({
        error: "Ugyldig results_url fra Travelpayouts (ikke absolutt URL)",
        details: { resultsUrl },
      });
    }

    flightSearchCache.set(String(searchId), {
      results_url: normalizedResultsUrl,
      created_at: Date.now(),
    });

    return res.json({
      ok: true,
      search_id: String(searchId),
      results_url: String(resultsUrl),
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const respHeaders = err?.response?.headers;

    console.error("❌ /api/flights/start feilet");
    console.error("STATUS:", status || "(no status)");
    console.error("MESSAGE:", err?.message || err);
    if (DEBUG) {
      console.error("🧪 TP ERROR DATA:", JSON.stringify(data || null, null, 2));
      console.error("🧪 TP ERROR HEADERS:", respHeaders || null);
    } else {
      console.error("TP ERROR DATA (short):", data || null);
    }

    return res.status(502).json({
      error: "Upstream start failed",
      tp_status: status || null,
      tp_error: data || null,
      // send kun debug tilbake om du ønsker det (kan fjernes)
      debug: DEBUG
        ? {
            message: err?.message || null,
          }
        : undefined,
    });
  }
});

/* ------------------------- RESULTS – /api/flights/results ------------------------- */

router.post("/flights/results", async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const { search_id, last_update_timestamp = 0 } = req.body || {};
    const sid = String(search_id || "").trim();
    const tsIn = Number(last_update_timestamp) || 0;

    if (!sid) return res.status(400).json({ error: "Mangler search_id" });

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt)." });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({
        error: "Cached results_url er ugyldig",
        details: { cached_results_url: cached.results_url },
      });
    }

    const resultsUrl = new URL("/search/affiliate/results", base).toString();
    const payload = { marker: tp.marker, search_id: sid, last_update_timestamp: tsIn };
    const signature = makeSignature(tp.token, payload);

    const r = await axios.post(
      resultsUrl,
      { ...payload, signature },
      {
        headers: makeHeaders(req, signature, tp),
        timeout: 25000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      }
    );

    if (r.status === 304) {
      return res.json({
        ok: true,
        is_over: false,
        last_update_timestamp: tsIn,
        offers: null, // app skal ikke overskrive eksisterende offers
      });
    }

    const data = r.data || {};
    const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
    const legsArr = Array.isArray(data?.flight_legs) ? data.flight_legs : [];

    const tpRawTs =
      typeof data.last_update_timestamp === "number"
        ? data.last_update_timestamp
        : typeof data.last_update_timestamp === "string"
        ? Number(data.last_update_timestamp) || 0
        : 0;

    const tpTs = Math.max(tsIn, tpRawTs || 0);
    const isOver = !!data.is_over;

    // ---------------- build legsById + resolveLeg ----------------

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

    // flights[] kan være indeks ELLER id
    const resolveLeg = (ref) => {
      if (ref == null) return null;
      if (typeof ref === "object") return ref;

      // 1) id-lookup
      const byId = legsById.get(String(ref));
      if (byId) return byId;

      // 2) index-lookup
      const idx = typeof ref === "number" ? ref : Number(ref);
      if (Number.isInteger(idx) && idx >= 0 && idx < legsArr.length) return legsArr[idx];

      return null;
    };

    // plukk felter fra et leg-objekt (flere varianter)
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
      return n > 10000 ? Math.round(n / 60) : n; // sek -> min hvis det ser stort ut
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

    // ---------------- build offers PER proposal ----------------

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
        const offer_id = `${sid}:${counter}`;
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

    // cache mapping offer_id -> tp_proposal_id (til click fallback)
    const map = {};
    for (const o of offers) if (o.offer_id && o.tp_proposal_id) map[o.offer_id] = o.tp_proposal_id;
    flightSearchCache.set(sid, { ...cached, offer_to_tp_proposal: map });

    return res.json({
      ok: true,
      is_over: isOver,
      last_update_timestamp: tpTs,
      offers,
    });
  } catch (e) {
    console.error("❌ /api/flights/results feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({
      error: "Upstream results failed",
      details: e?.response?.data || null,
    });
  }
});

/* ------------------------- CLICK – /api/flights/click ------------------------- */
/**
 * Viktig:
 * - Denne MÅ IKKE bruke makeHeaders(req, "", tp) hvis makeHeaders krever signature.
 * - Vi lager derfor en egen header-builder for click uten signature.
 * - Click-endepunktet kan returnere url i body, eller via Location header (redirect).
 */
router.post("/flights/click", async (req, res) => {
  try {
    const tp = getTpConfig();
    const okCfg = assertTpConfigured(tp);
    if (!okCfg.ok) return res.status(okCfg.status).json({ error: okCfg.error });

    const { search_id, offer_id, proposal_id, tp_proposal_id } = req.body || {};
    const sid = String(search_id || "").trim();

    const clientOfferId = String(offer_id || proposal_id || "").trim();
    const clientTpProposalId = tp_proposal_id != null ? String(tp_proposal_id).trim() : "";

    if (!sid) return res.status(400).json({ error: "Mangler search_id" });
    if (!clientTpProposalId && !clientOfferId) {
      return res.status(400).json({ error: "Mangler tp_proposal_id eller offer_id/proposal_id" });
    }

    const cached = flightSearchCache.get(sid);
    if (!cached?.results_url) {
      return res.status(404).json({ error: "Ukjent search_id (start på nytt)." });
    }

    const base = normalizeAbsoluteUrl(cached.results_url);
    if (!base) {
      return res.status(502).json({
        error: "Cached results_url er ugyldig",
        details: { cached_results_url: cached.results_url },
      });
    }

    // Click trenger token+realhost+ip, men ikke signature
    function makeClickHeaders() {
      // makeHeaders kan feile hvis den forventer signature -> bygg "light" headers her
      const headers = {
        Accept: "application/json",
        "x-affiliate-user-id": String(tp.token),
        "x-real-host": String(tp.realHost),
        // marker i header (TP ber om den i noen varianter)
        "x-affiliate-marker": String(tp.marker),
        "x-affiliate-mark": String(tp.marker),
        "x-affiliate-marker-id": String(tp.marker),
        "x-marker": String(tp.marker),
        marker: String(tp.marker),
      };

      // prøv å hente ip fra makeHeaders uten signature hvis din makeHeaders er gjort valgfri,
      // men ikke la det knekke click om den kaster
      try {
        const maybe = makeHeaders(req, null, tp);
        if (maybe?.["x-user-ip"]) headers["x-user-ip"] = maybe["x-user-ip"];
      } catch {
        // ignorer
      }

      return headers;
    }

    async function doTpClick(tpProposalId, sourceLabel) {
      const clickUrl = new URL(
        `/searches/${encodeURIComponent(sid)}/clicks/${encodeURIComponent(String(tpProposalId))}`,
        base
      ).toString();

      const cr = await axios.get(clickUrl, {
        headers: makeClickHeaders(),
        timeout: 25000,
        validateStatus: (status) => status >= 200 && status < 400,
        maxRedirects: 0, // vi vil fange Location selv
      });

      const url = normalizeClickUrl(cr?.data, cr?.headers);
      if (!url) {
        return {
          ok: false,
          status: 502,
          error: "TP click manglet url (uventet respons)",
          details: { status: cr.status, data: cr.data || null, headers: cr.headers || null },
        };
      }

      return { ok: true, url, source: sourceLabel };
    }

    // 1) direkte tp_proposal_id (best)
    if (clientTpProposalId) {
      const r = await doTpClick(clientTpProposalId, "tp_click_direct");
      if (!r.ok) return res.status(r.status || 502).json({ error: r.error, details: r.details || null });
      return res.json({ ok: true, url: r.url, source: r.source });
    }

    // 2) offer_id -> cached mapping (krever at results har kjørt)
    const cachedProposal = cached?.offer_to_tp_proposal?.[clientOfferId];
    if (cachedProposal) {
      const r = await doTpClick(cachedProposal, "tp_click_cached_map");
      if (!r.ok) return res.status(r.status || 502).json({ error: r.error, details: r.details || null });
      return res.json({ ok: true, url: r.url, source: r.source });
    }

    return res.status(404).json({
      error: "Fant ikke cached mapping for offer_id – kjør /api/flights/results først (så click).",
      details: { offer_id: clientOfferId || null },
    });
  } catch (e) {
    console.error("❌ /api/flights/click feilet:", e?.response?.data || e?.message || e);
    return res.status(502).json({ error: "Upstream click failed", details: e?.response?.data || null });
  }
});

export default router;
