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

export const travelpayoutsConfig = {
  token: env("TRAVELPAYOUTS_TOKEN") || env("TP_API_TOKEN"),
  marker: env("TRAVELPAYOUTS_MARKER") || env("TP_MARKER"),
  realHost: normalizeRealHost(env("TRAVELPAYOUTS_REAL_HOST") || env("TP_REAL_HOST")),
  lang: env("TRAVELPAYOUTS_LANG") || "en",
};

export function getTpConfig() {
  return travelpayoutsConfig;
}

export function assertTpConfigured(tp = travelpayoutsConfig) {
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

// Debug kun i dev
if (process.env.NODE_ENV !== "production") {
  console.log("✈️ Travelpayouts config:", {
    hasToken: !!travelpayoutsConfig.token,
    hasMarker: !!travelpayoutsConfig.marker,
    hasRealHost: !!travelpayoutsConfig.realHost,
    realHost: travelpayoutsConfig.realHost,
    lang: travelpayoutsConfig.lang,
  });
}
