// backend/services/travelpayouts/tpConfig.js (ESM)

const env = (k) => (process.env[k] || "").trim();

function normalizeRealHost(v) {
  // host uten scheme og uten trailing slash
  return String(v || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();
}

export function getTpConfig() {
  // Les env NÅ (ved kall), ikke når modulen importeres
  const token = env("TRAVELPAYOUTS_TOKEN") || env("TP_API_TOKEN") || env("TP_TOKEN");
  const marker = env("TRAVELPAYOUTS_MARKER") || env("TP_MARKER");
  const realHost = normalizeRealHost(env("TRAVELPAYOUTS_REAL_HOST") || env("TP_REAL_HOST"));

  return {
    token,
    marker,
    realHost, // f.eks. "podtech.no"
    lang: env("TRAVELPAYOUTS_LANG") || "en",
  };
}

export function assertTpConfigured(tp) {
  if (!tp?.token || !tp?.marker) {
    return {
      ok: false,
      status: 500,
      error:
        "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_TOKEN / TRAVELPAYOUTS_MARKER mangler)",
    };
  }
  if (!tp?.realHost) {
    return {
      ok: false,
      status: 500,
      error: "Travelpayouts er ikke konfigurert (TRAVELPAYOUTS_REAL_HOST mangler)",
    };
  }
  return { ok: true };
}

// Kall denne fra index.js etter dotenv (valgfritt)
export function logTpConfigIfDev() {
  if (process.env.NODE_ENV !== "production") {
    const tp = getTpConfig();
    console.log("✈️ Travelpayouts config:", {
      hasToken: !!tp.token,
      hasMarker: !!tp.marker,
      hasRealHost: !!tp.realHost,
      realHost: tp.realHost,
      lang: tp.lang,
    });
  }
}
