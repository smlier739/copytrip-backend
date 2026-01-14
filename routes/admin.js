// routes/admin.js
import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import pool from "../db.js"; // pg Pool (default export)

const router = express.Router();

function toIntOrDefault(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 1) KPI summary (1 rad)
router.get("/dashboard-summary", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_dashboard_summary LIMIT 1`);
    res.json({ data: rows[0] || null });
  } catch (e) {
    console.error("[admin] /dashboard-summary error:", e?.message || e);
    res.status(500).json({ error: "Kunne ikke hente dashboard summary." });
  }
});

// 2) Timeseries (unified: hour+day)
router.get("/timeseries", requireAdmin, async (req, res) => {
  try {
    const grainRaw = (req.query.grain || "all").toString().toLowerCase();
    const grain = ["hour", "day", "all"].includes(grainRaw) ? grainRaw : "all";

    const limit = Math.min(Math.max(toIntOrDefault(req.query.limit, 200), 1), 2000);

    const params = [];
    let whereSql = "";

    if (grain === "hour" || grain === "day") {
      params.push(grain);
      whereSql = `WHERE grain = $${params.length}`;
    }

    // parameterisert LIMIT
    params.push(limit);
    const limitSql = `LIMIT $${params.length}`;

    const q = `
      SELECT *
      FROM v_admin_timeseries_unified
      ${whereSql}
      ORDER BY day DESC
      ${limitSql}
    `;

    const { rows } = await pool.query(q, params);
    res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /timeseries error:", e?.message || e);
    res.status(500).json({ error: "Kunne ikke hente timeseries." });
  }
});

// 3) Top posts (hvis du har disse viewene)
router.get("/top-posts-7d", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_7d`);
    res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /top-posts-7d error:", e?.message || e);
    res.status(500).json({ error: "Kunne ikke hente top posts (7d)." });
  }
});

router.get("/top-posts-30d", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_30d`);
    res.json({ data: rows });
  } catch (e) {
    console.error("[admin] /top-posts-30d error:", e?.message || e);
    res.status(500).json({ error: "Kunne ikke hente top posts (30d)." });
  }
});

export default router;
