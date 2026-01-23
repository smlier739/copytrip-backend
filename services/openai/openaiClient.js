// backend/services/openai/openaiClient.js (ESM)

import OpenAI from "openai";

let client;

/**
 * Returnerer singleton OpenAI-klient
 * Støtter både responses API og chat.completions
 */
export function getOpenAI() {
  if (client) return client;

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error("❌ OPENAI_API_KEY mangler i environment");
  }

  if (!apiKey.startsWith("sk-")) {
    console.warn(
      "⚠️ OPENAI_API_KEY ser uvanlig ut (mangler 'sk-'-prefix). Fortsetter likevel."
    );
  }

  client = new OpenAI({
    apiKey,
    // baseURL: process.env.OPENAI_BASE_URL, // kun hvis du bruker proxy / Azure
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("✅ OpenAI-klient initialisert");
  }

  return client;
}
