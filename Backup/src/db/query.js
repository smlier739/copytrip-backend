// backend/src/db/query.js
import { createPool } from "./pool.js";

const pool = createPool();

export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await fn(client);
    await client.query("COMMIT");
    return res;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  if (process.env.NODE_ENV !== "production") {
    console.log("SQL:", text, params);
  }
  ...
}
