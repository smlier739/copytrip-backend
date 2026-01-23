// backend/services/db/query.js (ESM)

import pool from "../../db.js"; // ✅ tilpass hvis din pool ligger et annet sted

export async function query(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } catch (err) {
    // Ikke logg params (kan inneholde sensitiv info)
    console.error("[db.query] error:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      where: err?.where,
    });
    throw err;
  } finally {
    client.release();
  }
}

export function sanitizeUser(row) {
  if (!row || typeof row !== "object") return null;

  // Fjern sensitive felt (utvid ved behov)
  const {
    password_hash,
    reset_token,
    reset_token_expires_at,
    ...rest
  } = row;

  return rest;
}
