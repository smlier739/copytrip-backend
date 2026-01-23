// backend/services/utils/entitlements.js (ESM)

import pool from "../../db.js";

export async function getUserEntitlements(userId) {
  if (!userId) {
    return {
      isPro: false,
      is_admin: false,
      is_premium: false,
    };
  }

  try {
    const r = await pool.query(
      `
      SELECT is_premium, is_admin
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (r.rowCount === 0) {
      return {
        isPro: false,
        is_admin: false,
        is_premium: false,
      };
    }

    const u = r.rows[0];

    const is_admin = u.is_admin === true;
    const is_premium = u.is_premium === true;

    return {
      isPro: is_admin || is_premium,
      is_admin,
      is_premium,
    };
  } catch (err) {
    console.error("❌ getUserEntitlements feilet:", err);

    // Fail-safe: aldri gi utilsiktet tilgang
    return {
      isPro: false,
      is_admin: false,
      is_premium: false,
    };
  }
}
