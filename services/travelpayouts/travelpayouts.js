//// src/config/travelpayouts.js
//import crypto from "crypto";
//
//const env = (k) => (process.env[k] || "").trim();
//
//export const travelpayoutsConfig = {
//  token: env("TRAVELPAYOUTS_TOKEN") || env("TP_API_TOKEN"),
//  marker: env("TRAVELPAYOUTS_MARKER") || env("TP_MARKER"),
//  realHost: (env("TRAVELPAYOUTS_REAL_HOST") || env("TP_REAL_HOST"))
//    .replace(/^https?:\/\//i, "")
//    .replace(/\/+$/, ""),
//  lang: env("TRAVELPAYOUTS_LANG") || "en",
//};
//
//// ---- SIGNATURE (KORREKT iht. Travelpayouts) ----
//// Sorter keys i objekter. Ikke sorter arrays (behold rekkefølgen).
//function collectValuesInOrder(obj, out = []) {
//  if (obj === null || obj === undefined) return out;
//
//  if (obj instanceof Date) {
//    out.push(obj.toISOString());
//    return out;
//  }
//
//  if (Array.isArray(obj)) {
//    for (const v of obj) collectValuesInOrder(v, out);
//    return out;
//  }
//
//  if (typeof obj === "object") {
//    const keys = Object.keys(obj)
//      .filter((k) => k !== "signature")
//      .sort((a, b) => a.localeCompare(b, "en"));
//
//    for (const k of keys) collectValuesInOrder(obj[k], out);
//    return out;
//  }
//
//  // primitive
//  out.push(String(obj));
//  return out;
//}
//
//export function makeSignature(token, bodyObj) {
//  const values = collectValuesInOrder(bodyObj, []);
//  // IKKE sorter values her – rekkefølgen kommer fra sorterte keys i payload
//  const base = [String(token), ...values].join(":");
//  return crypto.createHash("md5").update(base).digest("hex");
//}
//
//// ---- HEADERS ----
//function normalizeIp(ip) {
//  if (!ip) return "";
//  return String(ip).replace(/^::ffff:/, "");
//}
//
//function getUserIp(req) {
//  if (!req) return "";
//  const xff = req.headers?.["x-forwarded-for"];
//  if (xff) return String(xff).split(",")[0].trim();
//  return String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "");
//}
//
//export function makeHeaders(req, signature, tp = travelpayoutsConfig) {
//  if (!tp?.token || !tp?.realHost) {
//    throw new Error("Travelpayouts headers: missing token/realHost");
//  }
//
//  const headers = {
//    "Content-Type": "application/json",
//    Accept: "application/json",
//    "x-affiliate-user-id": tp.token,
//    "x-real-host": tp.realHost,
//    "x-signature": signature,
//  };
//
//  const ip = normalizeIp(getUserIp(req));
//  if (ip) headers["x-user-ip"] = ip;
//
//  return headers;
//}
