// backend/db.js
import pkg from "pg";
const { Pool } = pkg;

let pool;

if (process.env.DATABASE_URL) {
  console.log("Bruker DATABASE_URL for Postgres-tilkobling");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false, // Render / hosted Postgres
    },
  });
} else {
  console.log("Bruker lokal DB-konfig (DB_HOST/DB_USER/...)");
  pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "copytrip_user",
    password: process.env.DB_PASSWORD || "superhemmelig",
    database: process.env.DB_NAME || "copytrip",
  });
}

export default pool;
