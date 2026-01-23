// backend/services/utils/sanitizeUser.js (ESM)

/**
 * Fjerner sensitive felt fra user-row før den sendes til klient
 */
export function sanitizeUser(row) {
  if (!row || typeof row !== "object") return null;

  const { password_hash, ...safe } = row;
  return safe;
}
