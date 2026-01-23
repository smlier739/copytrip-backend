// backend/services/travelAdvice/permissions.js (ESM)

export function canSeeTripDetailsForUser(user) {
  return !!(user?.is_admin || user?.is_premium);
}
