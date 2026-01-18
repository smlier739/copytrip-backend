// routes/admin.js
import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import pool from "../db.js";

const router = express.Router();

function toIntOrDefault(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Viktig: auth først, så admin-sjekk
router.use(authMiddleware);
router.use(requireAdmin);

// 1) KPI summary
router.get("/dashboard-summary", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM v_admin_dashboard_summary LIMIT 1`
    );
    return res.json({ data: rows[0] || null });
  } catch (e) {
    console.error("[admin] /dashboard-summary error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente dashboard summary." });
  }
});

// 2) Timeseries
router.get("/timeseries", async (req, res) => {
  try {
    const grainRaw = String(req.query.grain || "all").toLowerCase();
    const grain = ["hour", "day", "all"].includes(grainRaw) ? grainRaw : "all";
    const limit = Math.min(Math.max(toIntOrDefault(req.query.limit, 200), 1), 2000);

    const params = [];
    let whereSql = "";

    if (grain === "hour" || grain === "day") {
      params.push(grain);
      whereSql = `WHERE grain = $${params.length}`;
    }

    params.push(limit);
    const q = `
      SELECT *
      FROM v_admin_timeseries_unified
      ${whereSql}
      ORDER BY day DESC
      LIMIT $${params.length}
    `;

    const { rows } = await pool.query(q, params);
    return res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /timeseries error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente timeseries." });
  }
});

// 3) Top posts
router.get("/top-posts-7d", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_7d`);
    return res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /top-posts-7d error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente top posts (7d)." });
  }
});

router.get("/top-posts-30d", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_30d`);
    return res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /top-posts-30d error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente top posts (30d)." });
  }
});

export default router;
