// routes/admin.js
import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { pool } from "../db.js"; // din pg Pool

const router = express.Router();

// 1) KPI summary (1 rad)
router.get("/dashboard-summary", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM v_admin_dashboard_summary LIMIT 1`);
  res.json({ data: rows[0] || null });
});

// 2) Timeseries (unified: hour+day)
router.get("/timeseries", requireAdmin, async (req, res) => {
  // valgfritt: ?grain=hour|day|all og/eller limit
  const grain = (req.query.grain || "all").toString();
  const limit = Math.min(Number(req.query.limit || 200), 2000);

  let where = "";
  const params = [];
  if (grain === "hour" || grain === "day") {
    params.push(grain);
    where = `WHERE grain = $1`;
  }

  const q = `
    SELECT *
    FROM v_admin_timeseries_unified
    ${where}
    ORDER BY day DESC
    LIMIT ${limit}
  `;

  const { rows } = await pool.query(q, params);
  res.json({ data: rows });
});

// 3) Top posts (hvis du har disse viewene)
router.get("/top-posts-7d", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_7d`);
  res.json({ data: rows });
});

router.get("/top-posts-30d", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_30d`);
  res.json({ data: rows });
});

export default router;
