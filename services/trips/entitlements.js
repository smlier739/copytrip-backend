// services/trips/entitlements.js (ESM)

async function getUserTripStats(userId) {
  const userRes = await query(
    `SELECT is_premium, free_trip_limit, is_admin FROM users WHERE id=$1`,
    [userId]
  );

  if (userRes.rowCount === 0) {
    throw new Error("Bruker ikke funnet i getUserTripStats");
  }

  const user = userRes.rows[0];
  const isAdmin = !!user.is_admin;
  const isPremium = !!user.is_premium;
  const isPro = isAdmin || isPremium;

  // Tell kun brukerreiser (tilpass etter ditt schema)
  const tripsRes = await query(
    `
    SELECT COUNT(*) AS count
    FROM trips
    WHERE user_id = $1
      AND (
        source_type IS NULL
        OR source_type = 'template'
        OR source_type = 'user_episode_trip'
      )
    `,
    [userId]
  );

  const tripCount = Number(tripsRes.rows?.[0]?.count || 0);

  // Gratisgrense gjelder normalt ikke Pro
  const freeLimit = isPro ? null : (user.free_trip_limit ?? 5);

  return {
    isAdmin,
    isPremium,
    isPro,
    tripCount,
    freeLimit,
  };
}

async function getUserEntitlements(userId) {
  const r = await query(`SELECT is_premium, is_admin, free_trip_limit FROM users WHERE id=$1`, [userId]);

  if (r.rowCount === 0) {
    throw new Error("Bruker ikke funnet i getUserEntitlements");
  }

  const u = r.rows[0];
  const isAdmin = !!u.is_admin;
  const isPremium = !!u.is_premium;
  const isPro = isAdmin || isPremium;

  return {
    isPro,
    is_admin: isAdmin,
    is_premium: isPremium,
    free_trip_limit: u.free_trip_limit ?? 5,
  };
}
