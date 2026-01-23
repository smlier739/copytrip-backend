// backend/utils/network.js
export function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}
