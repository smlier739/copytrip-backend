// backend/services/travelAdvice/buildTravelAdviceText.js (ESM)

import { getOpenAI } from "../openai/openaiClient.js";

// ---------- hardkodet fallback ----------
function buildGenericTravelAdviceText(countryRaw) {
  const country = countryRaw ? String(countryRaw).trim() : null;

  if (!country) {
    return (
      "Fant ikke noe tydelig land for denne reisen.\n\n" +
      "For oppdaterte offisielle reiseråd, se Utenriksdepartementets reiseinformasjon på regjeringen.no."
    );
  }

  const lower = country.toLowerCase();

  if (lower === "italia") {
    return (
      "Reiseråd for Italia (ikke offisielt, kun veiledende):\n\n" +
      "• Vær oppmerksom på lommetyveri i turistområder.\n" +
      "• Følg lokale trafikk- og parkeringsregler.\n" +
      "• Ekstrem varme og skogbrannfare kan forekomme.\n" +
      "• Ta høyde for streiker i transportsektoren i perioder.\n" +
      "• Oppbevar pass/ID trygt og ha kopi tilgjengelig.\n\n" +
      "Sjekk alltid offisielle reiseråd fra Utenriksdepartementet før avreise."
    );
  }

  if (lower === "norge") {
    return (
      "Reiseråd for Norge (ikke offisielt, kun veiledende):\n\n" +
      "• Værforhold kan endre seg raskt, spesielt i fjellet.\n" +
      "• Følg lokale varsler om ras, flom og skred.\n" +
      "• Kle deg etter lag-på-lag-prinsippet og ha med ekstra varmeplagg.\n" +
      "• Planlegg ruter og værdekning i områder med dårlig mobildekning.\n\n" +
      "Se offisielle råd fra norske myndigheter."
    );
  }

  return (
    `Reiseråd for ${country} (ikke offisielt, kun veiledende):\n\n` +
    "• Sjekk sikkerhetssituasjon og lokale forhold.\n" +
    "• Sørg for gyldig reiseforsikring.\n" +
    "• Kontroller pass-, visum- og eventuelle vaksinekrav.\n" +
    "• Ha en plan for betaling (kort/kontanter) og nødnummer.\n" +
    "• Respekter lokale lover, skikker og fotoregler.\n\n" +
    "Sjekk alltid offisielle reiseråd fra Utenriksdepartementet før avreise."
  );
}

// Fjern lenker hvis modellen likevel legger inn URL
function stripLinks(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sikre formatkrav “i etterkant”
function ensureFormat(text, country) {
  let out = String(text || "").trim();
  out = stripLinks(out);

  const header = `Reiseråd for ${country} (ikke offisielt, kun veiledende)`;
  if (!out.toLowerCase().startsWith(header.toLowerCase())) {
    out = `${header}\n\n${out}`;
  }

  // Sørg for at vi har bullets
  const hasBullet = /(^|\n)\s*•\s+/.test(out);
  if (!hasBullet) {
    // Hvis modellen ga paragraf, lag enkel bulletisering
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const body = lines.slice(1);
    const bullets = body.slice(0, 8).map((l) => `• ${l.replace(/^[-•]\s*/, "")}`);
    out = `${header}\n\n${bullets.join("\n")}`;
  }

  // Sørg for UD-henvisning
  const hasUD = /utenriksdepartementet|ud\b/i.test(out);
  if (!hasUD) {
    out += "\n\nSjekk alltid offisielle reiseråd fra Utenriksdepartementet før avreise.";
  }

  return out.trim();
}

// ---------- KI-basert ----------
export async function buildTravelAdviceText(countryRaw) {
  const country = countryRaw ? String(countryRaw).trim() : null;
  if (!country) return buildGenericTravelAdviceText(null);

  const openai = getOpenAI();

  try {
    const systemPrompt = `
Du gir uoffisielle, generelle reiseråd på norsk.

KRAV:
- Start med: "Reiseråd for <LAND> (ikke offisielt, kun veiledende)"
- 5–8 punkter, hvert punkt starter med "• "
- Avslutt med henvisning til Utenriksdepartementet
- Ingen lenker og ingen URL-er
- Ikke skriv om interne vurderinger
`.trim();

    const userPrompt = `Land: ${country}`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_TRAVEL_ADVICE || process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) return buildGenericTravelAdviceText(country);

    return ensureFormat(text, country);
  } catch (e) {
    console.error("buildTravelAdviceText feilet:", e);
    return buildGenericTravelAdviceText(country);
  }
}
