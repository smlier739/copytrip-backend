// backend/routes/community.js (ESM)

import express from "express";
import pool from "../db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import adminOnlyMiddleware from "../middleware/adminOnlyMiddleware.js";
import { communityUpload } from "../services/uploads/communityUploads.js";

const router = express.Router();

async function query(text, params) {
  return pool.query(text, params);
}

// -------------------------------------------------------
//  COMMUNITY: KATEGORIER
// -------------------------------------------------------
router.get("/categories", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name FROM community_categories ORDER BY name ASC`
    );
    return res.json({ categories: result.rows });
  } catch (e) {
    console.error("/api/community/categories GET error:", e);
    return res.status(500).json({ error: "Kunne ikke hente kategorier." });
  }
});

// -------------------------------------------------------
//  COMMUNITY: FEED
// -------------------------------------------------------
router.get("/posts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `
      SELECT
        p.id,
        p.user_id,
        COALESCE(p.user_name, u.full_name, 'Ukjent bruker') AS author_name,
        p.title,
        p.text AS content,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        p.answer,
        p.answered_at,
        EXISTS(
          SELECT 1
          FROM community_likes l
          WHERE l.post_id = p.id AND l.user_id = $1
        ) AS liked_by_me
      FROM community_posts p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN community_categories c ON c.id = p.category_id
      ORDER BY p.created_at DESC
      `,
      [userId]
    );

    const posts = result.rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      author_name: r.author_name,
      title: r.title || "Innlegg",
      content: r.content || "",
      created_at: r.created_at,
      category_id: r.category_id,
      category_name: r.category_name || null,
      images: Array.isArray(r.images) ? r.images : [],
      likes: Number(r.likes || 0),
      likedByMe: !!r.liked_by_me,
      answer: r.answer || null,
      answered_at: r.answered_at || null,
    }));

    return res.json({ posts });
  } catch (e) {
    console.error("/api/community/posts GET-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente community-poster." });
  }
});

// -------------------------------------------------------
//  COMMUNITY: DETAIL
// -------------------------------------------------------
router.get("/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    const result = await query(
      `
      SELECT
        p.id,
        p.user_id,
        COALESCE(p.user_name, u.full_name, 'Ukjent bruker') AS author_name,
        p.title,
        p.text AS content,
        p.created_at,
        p.category_id,
        c.name AS category_name,
        p.images,
        p.likes,
        p.answer,
        p.answer_by,
        p.answered_at,
        EXISTS(
          SELECT 1
          FROM community_likes l
          WHERE l.post_id = p.id AND l.user_id = $1
        ) AS liked_by_me
      FROM community_posts p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN community_categories c ON c.id = p.category_id
      WHERE p.id = $2
      LIMIT 1
      `,
      [userId, postId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Post ikke funnet." });
    }

    const r = result.rows[0];

    return res.json({
      post: {
        id: r.id,
        user_id: r.user_id,
        author_name: r.author_name,
        title: r.title || "Innlegg",
        content: r.content || "",
        created_at: r.created_at,
        category_id: r.category_id,
        category_name: r.category_name || null,
        images: Array.isArray(r.images) ? r.images : [],
        likes: Number(r.likes || 0),
        likedByMe: !!r.liked_by_me,
        answer: r.answer || null,
        answer_by: r.answer_by || null,
        answered_at: r.answered_at || null,
      },
    });
  } catch (e) {
    console.error("/api/community/posts/:id GET-feil:", e);
    return res.status(500).json({ error: "Kunne ikke hente innlegget." });
  }
});

// -------------------------------------------------------
//  COMMUNITY: OPPRETT POST
// -------------------------------------------------------
router.post("/posts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { title, body, text, content, message, category_id, images } = req.body || {};
    console.log("POST /api/community/posts req.body =", req.body);

    const pickText = (...vals) =>
      vals.find((v) => typeof v === "string" && v.trim())?.trim() || "";

    const finalTitle = pickText(title);
    const finalBody = pickText(body, text, content, message);

    if (!finalBody) {
      return res.status(400).json({ error: "Tekst kan ikke være tom." });
    }

    // Hent visningsnavn
    const userRes = await query(`SELECT full_name FROM users WHERE id=$1`, [userId]);
    const userName = userRes.rows[0]?.full_name || "Ukjent bruker";

    // category_id → number | null (robust)
    const categoryIdValue =
      typeof category_id === "number"
        ? category_id
        : typeof category_id === "string" && /^\d+$/.test(category_id)
        ? Number(category_id)
        : null;

    // images → string[] (robust)
    const normalizeUrl = (u) => {
      if (typeof u !== "string") return null;
      const s = u.trim();
      if (!s) return null;

      // relative (fra uploads)
      if (s.startsWith("/uploads/")) return s;
      // absolute url
      if (/^https?:\/\/\S+$/i.test(s)) return s;

      return null;
    };

    let imagesValue = [];

    if (Array.isArray(images)) {
      imagesValue = images.map(normalizeUrl).filter(Boolean);
    } else if (typeof images === "string") {
      const one = normalizeUrl(images);
      if (one) imagesValue = [one];
    } else if (images && Array.isArray(images.urls)) {
      imagesValue = images.urls.map(normalizeUrl).filter(Boolean);
    }

    const insert = await query(
      `
      INSERT INTO community_posts (user_id, user_name, title, text, category_id, images)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [userId, userName, finalTitle || null, finalBody, categoryIdValue, imagesValue]
    );

    const row = insert.rows[0];

    return res.json({
      post: {
        id: row.id,
        user_id: row.user_id,
        author_name: row.user_name || userName,
        title: row.title || "Innlegg",
        content: row.text,
        created_at: row.created_at,
        category_id: row.category_id,
        images: Array.isArray(row.images) ? row.images : [],
        likes: Number(row.likes || 0),
        likedByMe: false,
        answer: row.answer || null,
        answered_at: row.answered_at || null,
      },
    });
  } catch (e) {
    console.error("/api/community/posts POST error:", e);
    return res.status(500).json({ error: "Kunne ikke lage community-post." });
  }
});

// -------------------------------------------------------
//  COMMUNITY: LIKE / UNLIKE
// -------------------------------------------------------
router.post("/posts/:id/like", authMiddleware, async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const userId = req.user.id;

    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    const exists = await query(
      `SELECT 1 FROM community_likes WHERE user_id=$1 AND post_id=$2`,
      [userId, postId]
    );

    if (exists.rowCount > 0) {
      await query(
        `DELETE FROM community_likes WHERE user_id=$1 AND post_id=$2`,
        [userId, postId]
      );
      await query(
        `UPDATE community_posts SET likes = GREATEST(likes - 1, 0) WHERE id=$1`,
        [postId]
      );
      return res.json({ liked: false });
    }

    await query(
      `INSERT INTO community_likes (user_id, post_id) VALUES ($1,$2)`,
      [userId, postId]
    );
    await query(
      `UPDATE community_posts SET likes = likes + 1 WHERE id=$1`,
      [postId]
    );

    return res.json({ liked: true });
  } catch (e) {
    console.error("/api/community/posts/:id/like error:", e);
    return res.status(500).json({ error: "Kunne ikke oppdatere like." });
  }
});

// -------------------------------------------------------
//  COMMUNITY: ADMIN SVAR
// -------------------------------------------------------
router.post(
  "/posts/:id/answer",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { answer } = req.body || {};

      if (!Number.isInteger(postId) || postId <= 0) {
        return res.status(400).json({ error: "Ugyldig post-id." });
      }

      if (!answer || !String(answer).trim()) {
        return res.status(400).json({ error: "Svaret kan ikke være tomt." });
      }

      // NB: answer_by: bruk gjerne req.user.full_name hvis du har det.
      const update = await query(
        `
        UPDATE community_posts
        SET answer=$1, answer_by=$2, answered_at=NOW()
        WHERE id=$3
        RETURNING *
        `,
        [String(answer).trim(), "Johnny", postId]
      );

      if (update.rowCount === 0) {
        return res.status(404).json({ error: "Post ikke funnet." });
      }

      const row = update.rows[0];
      return res.json({
        post: {
          id: row.id,
          answer: row.answer,
          answer_by: row.answer_by,
          answered_at: row.answered_at,
        },
      });
    } catch (e) {
      console.error("/api/community/posts/:id/answer error:", e);
      return res.status(500).json({ error: "Kunne ikke lagre svar." });
    }
  }
);

// -------------------------------------------------------
//  COMMUNITY: BILDEOPPLASTING (for innlegg)
// -------------------------------------------------------
router.post(
  "/uploads",
  authMiddleware,
  communityUpload.array("images", 10),
  async (req, res) => {
    try {
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({ error: "Ingen bildefiler ble lastet opp." });
      }

      // Relative URL-er som matches av app.use("/uploads", express.static(...))
      const urls = files.map((f) => `/uploads/${f.filename}`);

      return res.json({ ok: true, urls });
    } catch (e) {
      console.error("/api/community/uploads-feil:", e);
      return res.status(500).json({ error: "Kunne ikke laste opp bilder." });
    }
  }
);

// -------------------------------------------------------
//  COMMUNITY: SLETT POST (owner eller admin)
// -------------------------------------------------------
router.delete("/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: "Ikke innlogget." });
    }

    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    // admin?
    const u = await query(`SELECT is_admin FROM users WHERE id=$1`, [userId]);
    if (!u.rows.length) {
      return res.status(401).json({ error: "Bruker finnes ikke." });
    }
    const isAdmin = u.rows[0].is_admin === true;

    // post?
    const p = await query(
      `SELECT id, user_id FROM community_posts WHERE id=$1`,
      [postId]
    );
    const post = p.rows[0];
    if (!post) {
      return res.status(404).json({ error: "Innlegg finnes ikke." });
    }

    const isOwner = post.user_id === userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Ikke tilgang til å slette dette innlegget." });
    }

    await query(`DELETE FROM community_posts WHERE id=$1`, [postId]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/community/posts/:id DELETE error:", e);
    return res.status(500).json({ error: "Kunne ikke slette innlegg." });
  }
});

export default router;
