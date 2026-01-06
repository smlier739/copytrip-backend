// backend/index.js – Grenseløs Reise backend






























// -------------------------------------------------------
//  AUTH
// -------------------------------------------------------

app.post("/api/auth/signup", async (req, res) => {
  const {
    email,
    password,
    fullName,
    birthYear,
    homeCity,
    homeCountry,
    travelStyle,
    budgetPerDay,
    experienceLevel
  } = req.body || {};

  if (!email || !password || !fullName) {
    return res.status(400).json({
      error: "Navn, e-post og passord må fylles ut."
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName  = fullName.trim();

  const birthYearValue =
    birthYear === null || birthYear === "" || birthYear === undefined
      ? null
      : Number(birthYear);

  const budgetPerDayValue =
    budgetPerDay === null || budgetPerDay === "" || budgetPerDay === undefined
      ? null
      : Number(budgetPerDay);

  try {
    // Sjekk om e-posten allerede finnes
    const exists = await query(
      "SELECT id FROM users WHERE email=$1",
      [normalizedEmail]
    );

    if (exists.rowCount > 0) {
      return res
        .status(400)
        .json({ error: "E-posten er allerede i bruk." });
    }

    const hash = await bcrypt.hash(password, 10);

    // Lagre med alle profilfeltene
    const insert = await query(
      `
      INSERT INTO users (
        email,
        password_hash,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING
        id,
        email,
        full_name,
        birth_year,
        home_city,
        home_country,
        travel_style,
        budget_per_day,
        experience_level,
        is_admin,
        is_premium,
        free_trip_limit,
        created_at
      `,
      [
        normalizedEmail,
        hash,
        normalizedName,
        birthYearValue,
        homeCity || null,
        homeCountry || null,
        travelStyle || null,
        budgetPerDayValue,
        experienceLevel || null
      ]
    );

    const user = insert.rows[0];

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d"
    });

    res.json({ token, user });
  } catch (e) {
    console.error("Signup-feil:", e);
    res.status(500).json({ error: "Kunne ikke opprette bruker." });
  }
});






app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  const normalizedEmail = (email || "").trim().toLowerCase();
  const normalizedPassword = (password || "");

  try {
    const result = await query("SELECT * FROM users WHERE email=$1", [
      normalizedEmail,
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(normalizedPassword, row.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Feil e-post eller passord." });
    }

    const token = jwt.sign({ userId: row.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: sanitizeUser(row) });
  } catch (e) {
    console.error("Login-feil:", e);
    res.status(500).json({ error: "Kunne ikke logge inn." });
  }
});

import crypto from "crypto";

// ============ FORGOT PASSWORD ============
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "E-post må fylles inn." });

  const normalizedEmail = String(email).trim().toLowerCase();

  // Alltid samme svar (ikke lekke om e-post finnes)
  const okResponse = {
    ok: true,
    message:
      "Hvis vi finner e-posten i systemet vårt, sender vi instruksjoner for å nullstille passordet."
  };

  try {
    // 1) Env-sjekk – gjør den eksplisitt her så du ser hva som mangler
    const missing = [];
    if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
    if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!process.env.RESEND_FROM) missing.push("RESEND_FROM");
    if (!process.env.FRONTEND_BASE_URL) missing.push("FRONTEND_BASE_URL");
    if (missing.length) {
      console.error("❌ Mangler miljøvariabler:", missing.join(", "));
      return res.status(500).json({ error: `Mangler miljøvariabler: ${missing.join(", ")}` });
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    const RESEND_FROM = process.env.RESEND_FROM;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL;

    const result = await query(
      "SELECT id, email FROM users WHERE email=$1",
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      return res.json(okResponse);
    }

    const userId = result.rows[0].id;

    // 2) Token
    const resetToken = jwt.sign(
      { userId, type: "password_reset" },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3) Reset-lenke til FRONTEND
      const resetUrl = `${FRONTEND_BASE_URL.replace(/\/+$/, "")}/endre-passord-i-grenselos-reise-appen/?token=${encodeURIComponent(resetToken)}`;
      
    // 4) Send e-post via Resend
    const sendRes = await resend.emails.send({
      from: RESEND_FROM,
      to: normalizedEmail,
      subject: "Nullstill passord – Grenseløs Reise",
      html: resetEmailHtml({ resetUrl })
    });

    // 5) Robust logging
    if (sendRes?.error) {
      console.error("❌ Resend send-feil:", {
        to: normalizedEmail,
        error: sendRes.error
      });
      // Returner fortsatt okResponse for å ikke lekke info,
      // men du får feilen i logs
      return res.json(okResponse);
    }

    console.log("✅ Resend forgot-password sendt:", {
      to: normalizedEmail,
      id: sendRes?.data?.id || sendRes?.id,
      from: RESEND_FROM
    });

    return res.json(okResponse);
  } catch (e) {
    console.error("/api/auth/forgot-password-feil:", e);
    // Fortsett å returnere okResponse for sikkerhet (valgfritt),
    // men du kan også returnere 500 hvis du vil.
    return res.json(okResponse);
  }
});


// ============ RESET PASSWORD ============
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "Mangler token eller passord (min 6 tegn)." });
    }

    if (!JWT_SECRET) {
      console.error("❌ JWT_SECRET mangler");
      return res.status(500).json({ error: "Server-konfigurasjon mangler." });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Ugyldig eller utløpt reset-token." });
    }

    if (!decoded?.userId || decoded?.type !== "password_reset") {
      return res.status(401).json({ error: "Ugyldig reset-token." });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);

    const r = await query(
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,email,full_name`,
      [hash, decoded.userId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: "Bruker ikke funnet." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/auth/reset-password-feil:", e);
    return res.status(500).json({ error: "Kunne ikke resette passord." });
  }
});

app.post("/api/dev/test-email", async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: "Mangler 'to'." });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM;

    const out = await resend.emails.send({
      from,
      to,
      subject: "Test fra Grenseløs Reise",
      html: "<p>Dette er en test. Hvis du ser denne er Resend OK ✅</p>"
    });

    res.json({ ok: true, out });
  } catch (e) {
    console.error("test-email feilet:", e);
    res.status(500).json({ error: e?.message || "test-email feilet" });
  }
});

















// -------------------------------------------------------
//  COMMUNITY (API som matcher appen)
// -------------------------------------------------------

// Kategorier
app.get("/api/community/categories", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name FROM community_categories ORDER BY name ASC`
    );
    res.json({ categories: result.rows });
  } catch (e) {
    console.error("/api/community/categories GET error:", e);
    res.status(500).json({ error: "Kunne ikke hente kategorier." });
  }
});

// Liste (feed)
app.get("/api/community/posts", authMiddleware, async (req, res) => {
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
      answered_at: r.answered_at || null
    }));

    res.json({ posts });
  } catch (e) {
    console.error("/api/community/posts GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente community-poster." });
  }
});

// Detail (brukes av CommunityPostDetailScreen)
app.get("/api/community/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // behold som string/int, ikke tving Number
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

    res.json({
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
        answered_at: r.answered_at || null
      }
    });
  } catch (e) {
    console.error("/api/community/posts/:id GET-feil:", e);
    res.status(500).json({ error: "Kunne ikke hente innlegget." });
  }
});

// Opprett post (matcher CommunityNewPostScreen)
app.post("/api/community/posts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { title, body, text, content, message, category_id, images } = req.body || {};
    console.log("POST /api/community/posts req.body =", req.body);

    const pickText = (...vals) =>
      vals.find((v) => typeof v === "string" && v.trim())?.trim() || "";

    const finalTitle = pickText(title);
    const finalBody  = pickText(body, text, content, message);

    if (!finalBody) {
      return res.status(400).json({ error: "Tekst kan ikke være tom." });
    }

    // Hent visningsnavn
    const userRes = await query(`SELECT full_name FROM users WHERE id=$1`, [userId]);
    const userName = userRes.rows[0]?.full_name || "Ukjent bruker";

    // ✅ category_id → number | null (robust)
    const categoryIdValue =
      typeof category_id === "number"
        ? category_id
        : typeof category_id === "string" && /^\d+$/.test(category_id)
          ? Number(category_id)
          : null;

    // ✅ images → string[] (robust)
    const normalizeUrl = (u) => {
      if (typeof u !== "string") return null;
      const s = u.trim();
      if (!s) return null;

      // Tillat både relative (/uploads/..) og full URL
      if (s.startsWith("/uploads/")) return s;
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

    console.log("DEBUG community insert:", {
      userId,
      finalTitle,
      finalBody,
      categoryIdValue,
      imagesCount: imagesValue.length,
      imagesSample: imagesValue.slice(0, 2)
    });

    const insert = await query(
      `
      INSERT INTO community_posts (user_id, user_name, title, text, category_id, images)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        userId,
        userName,
        finalTitle || null,
        finalBody,
        categoryIdValue,
        imagesValue
      ]
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
        answered_at: row.answered_at || null
      }
    });
  } catch (e) {
    console.error("/api/community/posts POST error:", e);
    return res.status(500).json({ error: "Kunne ikke lage community-post." });
  }
});




// Like/unlike
app.post("/api/community/posts/:id/like", authMiddleware, async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const userId = req.user.id;

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

    res.json({ liked: true });
  } catch (e) {
    console.error("/api/community/posts/:id/like error:", e);
    res.status(500).json({ error: "Kunne ikke oppdatere like." });
  }
});

// Admin: svar
app.post(
  "/api/community/posts/:id/answer",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { answer } = req.body || {};

      if (!answer || !answer.trim()) {
        return res.status(400).json({ error: "Svaret kan ikke være tomt." });
      }

      const update = await query(
        `
        UPDATE community_posts
        SET answer=$1, answer_by=$2, answered_at=NOW()
        WHERE id=$3
        RETURNING *
        `,
        [answer.trim(), "Johnny", postId]
      );

      if (update.rowCount === 0) {
        return res.status(404).json({ error: "Post ikke funnet." });
      }

      const row = update.rows[0];
      res.json({
        post: {
          id: row.id,
          answer: row.answer,
          answer_by: row.answer_by,
          answered_at: row.answered_at
        }
      });
    } catch (e) {
      console.error("/api/community/posts/:id/answer error:", e);
      res.status(500).json({ error: "Kunne ikke lagre svar." });
    }
  }
);

// -------------------------------------------------------
//  COMMUNITY: BILDEOPPLASTING (for innlegg)
// -------------------------------------------------------

app.post(
  "/api/community/uploads",
  authMiddleware,
  upload.array("images", 10),
  async (req, res) => {
    try {
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({ error: "Ingen bildefiler ble lastet opp." });
      }

      // Returner relative URL-er som funker mot samme backend-baseURL
      const urls = files.map((f) => `/uploads/${f.filename}`);

      res.json({ ok: true, urls });
    } catch (e) {
      console.error("/api/community/uploads-feil:", e);
      res.status(500).json({ error: "Kunne ikke laste opp bilder." });
    }
  }
);

app.delete("/api/community/posts/:id", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: "Ikke innlogget." });
    }

    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: "Ugyldig post-id." });
    }

    // 🔐 admin?
    const u = await query(`SELECT is_admin FROM users WHERE id=$1`, [userId]);
    if (!u.rows.length) {
      return res.status(401).json({ error: "Bruker finnes ikke." });
    }
    const isAdmin = u.rows[0].is_admin === true;

    // 📄 post?
    const p = await query(`SELECT id, user_id FROM community_posts WHERE id=$1`, [postId]);
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
    // evt: return res.status(204).send();
  } catch (e) {
    console.error("/api/community/posts/:id DELETE error:", e);
    return res.status(500).json({ error: "Kunne ikke slette innlegg." });
  }
});

// Multer / upload-feil → 400 (ikke 500)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message?.includes("tillatt")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// -------------------------------------------------------
//  GLOBAL FEILHANDLER
// -------------------------------------------------------

app.use((err, req, res, next) => {
  if (err && (err instanceof multer.MulterError || err.message)) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// -------------------------------------------------------
//  SERVER START
// -------------------------------------------------------

app.listen(PORT, () => {
  if (process.env.NODE_ENV === "production") {
    assertEnvOrThrow();
  }
  console.log(`🚀 Grenseløs Reise backend kjører på port ${PORT}`);
});
