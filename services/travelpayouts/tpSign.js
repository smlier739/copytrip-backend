// backend/services/travelpayouts/tpSign.js (ESM)

import crypto from "crypto";

// ---- SIGNATURE ----
function collectValuesInOrder(obj, out = []) {
  if (obj === null || obj === undefined) return out;

  if (obj instanceof Date) {
    out.push(obj.toISOString());
    return out;
  }

  if (Array.isArray(obj)) {
    for (const v of obj) collectValuesInOrder(v, out);
    return out;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj)
      .filter((k) => k !== "signature")
      .sort(); // deterministisk uten locale

    for (const k of keys) collectValuesInOrder(obj[k], out);
    return out;
  }

  // primitives
  out.push(String(obj));
  return out;
}

export function makeSignature(token, bodyObj) {
  const t = String(token || "");
  const values = collectValuesInOrder(bodyObj, []);
  const base = [t, ...values].join(":");

  return crypto
    .createHash("md5")
    .update(base, "utf8")
    .digest("hex");
}

// ---- HEADERS ----
function normalizeIp(ip) {
  if (!ip) return "";
  const s = String(ip).trim();

  // IPv4-mapped IPv6: ::ffff:1.2.3.4
  const v4 = s.replace(/^::ffff:/, "");

  // strip port if any (rare, but safe)
  // e.g. "1.2.3.4:12345" or "[2001:db8::1]:12345"
  return v4
    .replace(/^\[([^\]]+)\](:\d+)?$/, "$1")
    .replace(/:\d+$/, "");
}

function getUserIp(req) {
  if (!req) return "";

  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();

  const xri = req.headers?.["x-real-ip"];
  if (xri) return String(xri).trim();

  // Express kan gi ip hvis trust proxy er satt:
  if (req.ip) return String(req.ip).trim();

  return String(req.socket?.remoteAddress || "").trim();
}

export function makeHeaders(req, signature, tp) {
  if (!tp?.token || !tp?.realHost) {
    throw new Error("Travelpayouts headers: missing token/realHost");
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-affiliate-user-id": String(tp.token),
    "x-real-host": String(tp.realHost),
  };

  // signature er kun påkrevd for de endepunktene som faktisk trenger det
  if (signature) headers["x-signature"] = String(signature);

  const ip = normalizeIp(getUserIp(req));
  if (ip) headers["x-user-ip"] = ip;

  return headers;
}
