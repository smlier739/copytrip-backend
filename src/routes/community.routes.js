import express from "express";
import { query } from "../db/query.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

/**
 * Helper: valgfri auth (gir req.user hvis token finnes, ellers null)
 */
async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token) {
      req.user = null;
      return next();
    }
    // Bruk din vanlige authMiddleware hvis den allerede gjør jwt->req.user
    // Her kaller vi den “try/catch”-trygt
    return authMiddleware(req, res, (err) => {
      if (err) req.user = null;
      next();
    });
  } catch {
    req.user = null;
    return next();
  }
}

/**
 * CATEGORIES
 */

// GET /api/community/categories
router.get("/api/community/categories", async (req, res) => {
  try {
    const r = await query(
      `
      SELECT id, name
      FROM community_categories
      ORDER BY name ASC
      `
    );
    return res.json({ categories: r.rows });
  } catch (e) {
    console.error("GET /api/community/categories error:", e);
    return res.status(500).json({ error: "Kunne ikke hente kategorier." });
  }
});

/**
 * POSTS
 */

// GET /api/community/posts?category_id=...&limit=...&offset=...
// Returnerer også likedByMe hvis innlogget (valgfritt)
router.get("/api/community/posts", optionalAuth, async (req, res) => {
  try {
    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const params = [];
    let where = "";

    if (Number.isFinite(categoryId)) {
      params.push(categoryId);
      where = `WHERE p.category_id = $${params.length}`;
    }

    // likedByMe: hvis innlogget
    const userId = req.user?.id || null;
    params.push(limit, offset);

    const likedSelect = userId
      ? `
        EXISTS(
          SELECT 1
          FROM community_likes cl
          WHERE cl.post_id = p.id AND cl.user_id = $${params.length + 1}
        ) AS "likedByMe"
      `
      : `false AS "likedByMe"`;

    const likedParam = userId ? [userId] : [];

    const r = await query(
      `
      SELECT
        p.id,
        p.user_id,
        p.user_name,
        p.title,
        p.text,
        p.answer,
        p.answer_by,
        p.answered_at,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        ${likedSelect}
      FROM community_posts p
      LEFT JOIN community_categories c ON c.id = p.category_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
      `,
      [...params, ...likedParam]
    );

    return res.json({ posts: r.rows, limit, offset });
  } catch (e) {
    console.error("GET /api/community/posts error:", e);
    return res.status(500).json({ error: "Kunne ikke hente innlegg." });
  }
});

// GET /api/community/posts/:id
router.get("/api/community/posts/:id", optionalAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Ugyldig id." });

    const userId = req.user?.id || null;

    const r = await query(
      `
      SELECT
        p.id,
        p.user_id,
        p.user_name,
        p.title,
        p.text,
        p.answer,
        p.answer_by,
        p.answered_at,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        ${
          userId
            ? `EXISTS(SELECT 1 FROM community_likes cl WHERE cl.post_id=p.id AND cl.user_id=$2) AS "likedByMe"`
            : `false AS "likedByMe"`
        }
      FROM community_posts p
      LEFT JOIN community_categories c ON c.id = p.category_id
      WHERE p.id = $1
      `,
      userId ? [id, userId] : [id]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Innlegg ikke funnet." });
    return res.json({ post: r.rows[0] });
  } catch (e) {
    console.error("GET /api/community/posts/:id error:", e);
    return res.status(500).json({ error: "Kunne ikke hente innlegg." });
  }
});

// POST /api/community/posts  (krever innlogging)
router.post("/api/community/posts", authMiddleware, async (req, res) => {
  try {
    const title = req.body.title != null ? String(req.body.title).trim() : null;
    const text = String(req.body.text || "").trim();
    const categoryId = req.body.category_id != null ? Number(req.body.category_id) : null;

    // images kan komme som array, eller som string -> vi støtter begge
    let images = req.body.images ?? [];
    if (typeof images === "string") images = [images];
    if (!Array.isArray(images)) images = [];
    images = images.map(String).filter(Boolean);

    if (!text) return res.status(400).json({ error: "Mangler tekst." });

    // user_name: bruk fra users.full_name hvis finnes, ellers epost-prefix
    const u = await query(`SELECT email, full_name FROM users WHERE id=$1`, [req.user.id]);
    const userName =
      (u.rows[0]?.full_name && String(u.rows[0].full_name).trim()) ||
      (u.rows[0]?.email ? String(u.rows[0].email).split("@")[0] : "Ukjent");

    const r = await query(
      `
      INSERT INTO community_posts (user_id, user_name, title, text, category_id, images, likes)
      VALUES ($1, $2, $3, $4, $5, $6::text[], 0)
      RETURNING *
      `,
      [req.user.id, userName, title, text, Number.isFinite(categoryId) ? categoryId : null, images]
    );

    return res.json({ post: r.rows[0] });
  } catch (e) {
    console.error("POST /api/community/posts error:", e);
    return res.status(500).json({ error: "Kunne ikke opprette innlegg." });
  }
});

// PATCH /api/community/posts/:id  (kun eier)
router.patch("/api/community/posts/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Ugyldig id." });

    const cur = await query(`SELECT id, user_id FROM community_posts WHERE id=$1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: "Innlegg ikke funnet." });
    if (cur.rows[0].user_id !== req.user.id) return res.status(403).json({ error: "Ikke tilgang." });

    const title = req.body.title != null ? String(req.body.title).trim() : null;
    const text = req.body.text != null ? String(req.body.text).trim() : null;
    const categoryId = req.body.category_id != null ? Number(req.body.category_id) : null;

    let images = req.body.images ?? null; // null => ikke endre
    if (images !== null) {
      if (typeof images === "string") images = [images];
      if (!Array.isArray(images)) images = [];
      images = images.map(String).filter(Boolean);
    }

    const r = await query(
      `
      UPDATE community_posts
      SET
        title = COALESCE($1, title),
        text = COALESCE($2, text),
        category_id = COALESCE($3, category_id),
        images = COALESCE($4::text[], images)
      WHERE id = $5
      RETURNING *
      `,
      [
        title,
        text,
        Number.isFinite(categoryId) ? categoryId : null,
        images,
        id,
      ]
    );

    return res.json({ post: r.rows[0] });
  } catch (e) {
    console.error("PATCH /api/community/posts/:id error:", e);
    return res.status(500).json({ error: "Kunne ikke oppdatere innlegg." });
  }
});

// POST /api/community/posts/:id/delete  (kun eier)
router.post("/api/community/posts/:id/delete", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Ugyldig id." });

    const cur = await query(`SELECT id, user_id FROM community_posts WHERE id=$1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: "Innlegg ikke funnet." });
    if (cur.rows[0].user_id !== req.user.id) return res.status(403).json({ error: "Ikke tilgang." });

    await query(`DELETE FROM community_posts WHERE id=$1`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/community/posts/:id error:", e);
    return res.status(500).json({ error: "Kunne ikke slette innlegg." });
  }
});

/**
 * LIKES (toggle)
 */

// POST /api/community/posts/:id/like
router.post("/api/community/posts/:id/like", authMiddleware, async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isFinite(postId)) return res.status(400).json({ error: "Ugyldig id." });

  try {
    // finnes post?
    const p = await query(`SELECT id FROM community_posts WHERE id=$1`, [postId]);
    if (p.rowCount === 0) return res.status(404).json({ error: "Innlegg ikke funnet." });

    // prøv å like
    const ins = await query(
      `
      INSERT INTO community_likes (user_id, post_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, post_id) DO NOTHING
      RETURNING user_id
      `,
      [req.user.id, postId]
    );

    if (ins.rowCount === 1) {
      // vi likte nå -> increment likes
      const upd = await query(
        `
        UPDATE community_posts
        SET likes = likes + 1
        WHERE id = $1
        RETURNING likes
        `,
        [postId]
      );
      return res.json({ ok: true, liked: true, likes: upd.rows[0].likes });
    }

    // ellers: unlike
    const del = await query(
      `
      DELETE FROM community_likes
      WHERE user_id=$1 AND post_id=$2
      RETURNING user_id
      `,
      [req.user.id, postId]
    );

    if (del.rowCount === 1) {
      const upd = await query(
        `
        UPDATE community_posts
        SET likes = GREATEST(likes - 1, 0)
        WHERE id = $1
        RETURNING likes
        `,
        [postId]
      );
      return res.json({ ok: true, liked: false, likes: upd.rows[0].likes });
    }

    // Burde ikke skje, men for sikkerhet:
    const cur = await query(`SELECT likes FROM community_posts WHERE id=$1`, [postId]);
    return res.json({ ok: true, liked: false, likes: cur.rows[0].likes });
  } catch (e) {
    console.error("POST /api/community/posts/:id/like error:", e);
    return res.status(500).json({ error: "Kunne ikke oppdatere like." });
  }
});

// PATCH /api/community/posts/:id/answer  (krever admin eller eier)
router.patch("/api/community/posts/:id/answer", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Ugyldig id." });

    const answer = req.body.answer != null ? String(req.body.answer).trim() : "";
    if (!answer) return res.status(400).json({ error: "Mangler svartekst." });

    const cur = await query(`SELECT id, user_id FROM community_posts WHERE id=$1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: "Innlegg ikke funnet." });

    // Tillat admin eller eier
    if (!req.user.is_admin && cur.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Ikke tilgang." });
    }

    const who = req.user.email?.split("@")[0] || "admin";

    const r = await query(
      `
      UPDATE community_posts
      SET answer=$1, answer_by=$2, answered_at=now()
      WHERE id=$3
      RETURNING *
      `,
      [answer, who, id]
    );

    return res.json({ post: r.rows[0] });
  } catch (e) {
    console.error("PATCH answer error:", e);
    return res.status(500).json({ error: "Kunne ikke lagre svar." });
  }
});

export default router;
