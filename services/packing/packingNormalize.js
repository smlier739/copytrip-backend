export function normalizePackingForClient(packing) {
  if (!packing) return [];

  let arr = [];

  if (Array.isArray(packing)) {
    arr = packing;
  } else if (typeof packing === "string") {
    try {
      const parsed = JSON.parse(packing);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  }

  // Valgfritt: defensiv rensing
  return arr.filter(
    (g) =>
      g &&
      typeof g === "object" &&
      typeof g.category === "string" &&
      Array.isArray(g.items)
  );
}
