// backend/services/db/query.js (ESM)

import pool from "../../db.js";

/**
 * Standard DB-query wrapper
 * - bruker pool direkte (riktig for pg.Pool)
 * - logger trygt ved feil
 */
export async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("[db.query] error:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      where: err?.where,
    });
    throw err;
  }
}
