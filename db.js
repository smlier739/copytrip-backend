// backend/db.js (ESM)
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config({ override: true });

const { Pool } = pkg;

const useUrl = !!process.env.DATABASE_URL;

const pool = useUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render/hosted Postgres
    })
  : new Pool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || "copytrip_user",
      password: process.env.DB_PASSWORD || "superhemmelig",
      database: process.env.DB_NAME || "copytrip",
    });

pool.on("error", (err) => {
  console.error("Postgres pool error:", err);
});

export default pool;
