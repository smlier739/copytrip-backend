// backend/src/db/pool.js
import pkg from "pg";
const { Pool } = pkg;

export function createPool() {
  if (process.env.DATABASE_URL) {
    console.log("Bruker DATABASE_URL for Postgres-tilkobling");
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }

  console.log("Bruker lokal DB-konfig (DB_HOST/DB_USER/...)");
  return new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "copytrip_user",
    password: process.env.DB_PASSWORD || "superhemmelig",
    database: process.env.DB_NAME || "copytrip",
  });
}
