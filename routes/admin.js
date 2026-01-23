// backend/routes/admin.js (ESM)

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import pool from "../db.js";

const router = express.Router();

function toIntOrDefault(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ✅ Viktig: auth først, så admin-sjekk (gjelder ALT i denne routeren)
router.use(authMiddleware);
router.use(requireAdmin);

// -------------------------------------------------------
//  KPI / Dashboard (views)
// -------------------------------------------------------

router.get("/dashboard-summary", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM v_admin_dashboard_summary LIMIT 1`
    );
    return res.json({ data: rows[0] || null });
  } catch (e) {
    console.error("[admin] GET /dashboard-summary error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente dashboard summary." });
  }
});

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
    console.error("[admin] GET /timeseries error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente timeseries." });
  }
});

router.get("/top-posts-7d", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_7d`);
    return res.json({ data: rows });
  } catch (e) {
    console.error("[admin] GET /top-posts-7d error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente top posts (7d)." });
  }
});

router.get("/top-posts-30d", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM v_admin_top_posts_30d`);
    return res.json({ data: rows });
  } catch (e) {
    console.error("[admin] GET /top-posts-30d error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente top posts (30d)." });
  }
});

// -------------------------------------------------------
//  ADMIN: Brukere
// -------------------------------------------------------

router.get("/users", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        email,
        full_name,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      FROM users
      ORDER BY created_at DESC
      `
    );

    return res.json({ users: rows });
  } catch (e) {
    console.error("[admin] GET /users error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke hente brukere." });
  }
});

router.post("/users/:id/toggle-admin", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    if (!targetId) return res.status(400).json({ error: "Mangler bruker-id." });

    const { rows, rowCount } = await pool.query(
      `
      UPDATE users
      SET is_admin = NOT is_admin
      WHERE id = $1
      RETURNING id,email,full_name,is_admin,is_premium,free_trip_limit,created_at
      `,
      [targetId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ user: rows[0] });
  } catch (e) {
    console.error("[admin] POST /users/:id/toggle-admin error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke oppdatere admin-rettigheter." });
  }
});

router.post("/users/:id/toggle-premium", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    if (!targetId) return res.status(400).json({ error: "Mangler bruker-id." });

    const { rows, rowCount } = await pool.query(
      `
      UPDATE users
      SET is_premium = NOT is_premium
      WHERE id = $1
      RETURNING id,email,full_name,is_admin,is_premium,free_trip_limit,created_at
      `,
      [targetId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ user: rows[0] });
  } catch (e) {
    console.error("[admin] POST /users/:id/toggle-premium error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke oppdatere premium-status." });
  }
});

router.post("/users/:id/set-free-limit", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    const limitRaw = req.body?.free_trip_limit;

    const limit = Number(limitRaw);
    if (!targetId) return res.status(400).json({ error: "Mangler bruker-id." });
    if (!Number.isFinite(limit) || limit < 0 || limit > 999) {
      return res.status(400).json({ error: "free_trip_limit må være et tall mellom 0 og 999." });
    }

    const { rows, rowCount } = await pool.query(
      `
      UPDATE users
      SET free_trip_limit = $2
      WHERE id = $1
      RETURNING id,email,full_name,is_admin,is_premium,free_trip_limit,created_at
      `,
      [targetId, Math.trunc(limit)]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ user: rows[0] });
  } catch (e) {
    console.error("[admin] POST /users/:id/set-free-limit error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke oppdatere free_trip_limit." });
  }
});

router.post("/users/:id/delete", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    if (!targetId) return res.status(400).json({ error: "Mangler bruker-id." });

    // Hindre admin i å slette seg selv
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ error: "Du kan ikke slette deg selv via admin-panelet." });
    }

    const { rows, rowCount } = await pool.query(
      `DELETE FROM users WHERE id=$1 RETURNING id,email`,
      [targetId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({
      success: true,
      deletedId: rows[0].id,
      email: rows[0].email,
    });
  } catch (e) {
    console.error("[admin] POST /users/:id/delete error:", e?.message || e);
    return res.status(500).json({ error: "Kunne ikke slette bruker." });
  }
});

export default router;
