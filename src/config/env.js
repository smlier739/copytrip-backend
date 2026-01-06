// backend/src/config/env.js
import dotenv from "dotenv";

export function loadEnv() {
  dotenv.config({ override: true });

  // Debug API-nøkkel prefix
  console.log(
    "DEBUG OPENAI_API_KEY prefix:",
    (process.env.OPENAI_API_KEY || "").slice(0, 12) || "IKKE SATT"
  );
}

export function assertEnvOrThrow(keys = []) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `Mangler miljøvariabler: ${missing.join(", ")}`;
    console.error("❌", msg);
    throw new Error(msg);
  }
}
