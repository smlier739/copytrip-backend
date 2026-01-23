// backend/services/travelpayouts/tpHttp.js (ESM)

function normalizeAbsoluteUrl(u) {
  if (!u) return "";

  let s = String(u).trim();
  if (!s) return "";

  // Hvis det er ren path, er det ugyldig i vårt tilfelle
  if (s.startsWith("/")) return "";

  // Scheme-relative URL
  if (s.startsWith("//")) s = "https:" + s;

  // Hvis det ikke har scheme, anta https://
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  // Valider/normaliser med URL parser
  let url;
  try {
    url = new URL(s);
  } catch {
    return "";
  }

  // Kun http/https
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";

  // Må ha host
  if (!url.hostname) return "";

  // Fjern trailing slash på pathname (men behold / hvis det er root)
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  // Returner uten trailing slash på slutten av hele stringen (for sikkerhet)
  // (URL-objektet vil ikke legge på ekstra slash uten grunn.)
  return url.toString().replace(/\/+$/, "");
}

export { normalizeAbsoluteUrl };
