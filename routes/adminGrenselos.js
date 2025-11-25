// backend/routes/adminGrenselos.js

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();

// Tilpass disse importene til ditt prosjekt:
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { GrenselosEpisode } = require('../db/models'); // ELLER riktig modell-path

// Rot for galleribilder: backend/uploads/grenselos-gallery
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'grenselos-gallery');

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const episodeId = req.params.episodeId;
    const dest = path.join(UPLOAD_ROOT, String(episodeId));
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});

const upload = multer({ storage });

/**
 * POST /api/admin/grenselos-episodes/:episodeId/gallery-upload
 * Felt: images (en eller flere filer)
 */
router.post(
  '/grenselos-episodes/:episodeId/gallery-upload',
  requireAuth,
  requireAdmin,
  upload.array('images', 20),
  async (req, res) => {
    try {
      const episodeId = req.params.episodeId;

      // Finn episoden i databasen – tilpass til din modell
      const episode = await GrenselosEpisode.findOne({
        where: { episode_id: episodeId }
      });

      if (!episode) {
        return res.status(404).json({ error: 'Episode ikke funnet.' });
      }

      const existingGallery = Array.isArray(episode.gallery)
        ? episode.gallery
        : [];

      const newItems = (req.files || []).map((file, idx) => {
        const relPath = `/uploads/grenselos-gallery/${episodeId}/${file.filename}`;
        return {
          url: relPath,
          title: `Bilde ${existingGallery.length + idx + 1}`,
          caption: ''
        };
      });

      const updatedGallery = [...existingGallery, ...newItems];

      episode.gallery = updatedGallery; // JSON-kolonne
      await episode.save();

      return res.json({
        success: true,
        episode_id: episodeId,
        gallery: updatedGallery
      });
    } catch (err) {
      console.error(
        '/api/admin/grenselos-episodes/:episodeId/gallery-upload error:',
        err
      );
      return res.status(500).json({
        error: 'Kunne ikke lagre galleri.'
      });
    }
  }
);

module.exports = router;
