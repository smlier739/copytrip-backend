// backend/src/config/openai.js
import OpenAI from "openai";

export function getOpenAI() {
  const openaiConfig = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.OPENAI_PROJECT_ID) openaiConfig.project = process.env.OPENAI_PROJECT_ID;
  return new OpenAI(openaiConfig);
}
