import { normalizeExperiencesArray } from "./normalizeExperiencesArray.js";

export function applyExperienceFallback({
  trip,
  episodeId
}) {
  if (trip.experiences.length > 0) return trip;

  const firstStop = trip.stops?.[0] || null;
  const loc = (firstStop?.name || "").toString().trim();

  trip.experiences = [
    {
      id: `exp-${episodeId}-fallback-1`,
      name: "Guidet opplevelse / byvandring",
      location: loc,
      description: "Sjekk tilgjengelige turer og billetter i området.",
      url: null,
      day: firstStop?.day ?? 1,
      price_per_person: null,
      currency: "NOK"
    },
    {
      id: `exp-${episodeId}-fallback-2`,
      name: "Museum / attraksjon",
      location: loc,
      description: "Et trygt valg på reisedager – sjekk åpningstider og billetter.",
      url: null,
      day: firstStop?.day ?? 1,
      price_per_person: null,
      currency: "NOK"
    }
  ];

  return trip;
}
