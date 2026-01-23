// backend/db.js (ESM)
import pkg from "pg";
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config(); // ikke override i prod
}

const { Pool } = pkg;

const hasDbUrl = !!process.env.DATABASE_URL;

// Valgfritt: styr ssl via env (default: true når DATABASE_URL)
const useSsl =
  hasDbUrl ? (process.env.DB_SSL ?? "true").toLowerCase() === "true" : false;

const pool = new Pool({
  ...(hasDbUrl
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER || "copytrip_user",
        password: process.env.DB_PASSWORD, // 👈 ikke hardcode
        database: process.env.DB_NAME || "copytrip",
      }),
  ...(useSsl
    ? {
        ssl: { rejectUnauthorized: false },
      }
    : {}),
  // Stabilitet
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
});

// Global error handler for pool
pool.on("error", (err) => {
  console.error("❌ Postgres pool error:", {
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
  });
});

export default pool;
