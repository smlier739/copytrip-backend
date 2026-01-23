// backend/routes/locations.js (ESM)

import express from "express";
import axios from "axios";

const router = express.Router();

router.get("/locations/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ locations: [] });

    const r = await axios.get("https://autocomplete.travelpayouts.com/places2", {
      params: {
        term: q,
        locale: "no",
        "types[]": ["city", "airport"],
      },
      timeout: 10000,
    });

    const locations = (Array.isArray(r.data) ? r.data : [])
      .slice(0, 10)
      .map((p) => ({
        id: p.code, // IATA
        code: p.code || null,
        name: p.name || p.city_name || p.country_name || p.code,
        city: p.city_name || null,
        country: p.country_name || null,
        type: p.type || null,
        subdivision: null,
      }));

    return res.json({ locations });
  } catch (e) {
    console.error("❌ TP autocomplete error:", e?.response?.data || e?.message || e);
    return res.status(502).json({ error: "Upstream autocomplete failed" });
  }
});

export default router;
