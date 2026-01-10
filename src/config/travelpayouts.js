// src/config/travelpayouts.js
// src/config/travelpayouts.js
import crypto from "crypto";

const env = (k) => (process.env[k] || "").trim();

export const travelpayoutsConfig = {
  token: env("TRAVELPAYOUTS_TOKEN") || env("TP_API_TOKEN"),
  marker: env("TRAVELPAYOUTS_MARKER") || env("TP_MARKER"),
  realHost: (env("TRAVELPAYOUTS_REAL_HOST") || env("TP_REAL_HOST"))
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, ""),
  lang: env("TRAVELPAYOUTS_LANG") || "en",
};

function collectValues(obj, out = []) {
  if (obj === null || obj === undefined) return out;

  if (obj instanceof Date) {
    out.push(obj.toISOString());
    return out;
  }

  if (Array.isArray(obj)) {
    for (const v of obj) collectValues(v, out);
    return out;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, "en"));
    for (const k of keys) {
      if (k === "signature") continue;
      collectValues(obj[k], out);
    }
    return out;
  }

  const s = String(obj);
  if (s !== "") out.push(s);
  return out;
}

export function makeSignature(token, marker, bodyObj) {
  const values = collectValues(bodyObj, []);
  values.sort((a, b) => a.localeCompare(b, "en"));
  const base = [String(token), String(marker), ...values].join(":");
  return crypto.createHash("md5").update(base).digest("hex");
}

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

function getUserIp(req) {
  if (!req) return "";
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return normalizeIp(String(xff).split(",")[0].trim());
  return normalizeIp(String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || ""));
}

export function makeHeaders(req, signature, tp = travelpayoutsConfig) {
  if (!tp?.token || !tp?.realHost) {
    throw new Error("Travelpayouts headers: missing token/realHost");
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-affiliate-user-id": tp.token,
    "x-real-host": tp.realHost,
  };

  if (signature) headers["x-signature"] = signature;

  const ip = getUserIp(req);
  if (ip) headers["x-user-ip"] = ip;

  return headers;
}
