import express from "express";
import cors from "cors";

import { uploadDir } from "./config/paths.js";
import { errorHandler } from "./middleware/errorHandler.js";

import healthRoutes from "./routes/health.routes.js";
import debugRoutes from "./routes/debug.routes.js";
import authRoutes from "./routes/auth.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import tripsRoutes from "./routes/trips.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import communityRoutes from "./routes/community.routes.js";
import spotifyRoutes from "./routes/spotify.routes.js";
import revenuecatWebhook from "./routes/webhooks/revenuecat.js";

export const app = express();

app.use("/api/webhooks", revenuecatWebhook);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));

app.use(healthRoutes);
app.use(debugRoutes);
app.use(authRoutes);
app.use(profileRoutes);
app.use(tripsRoutes);
app.use(aiRoutes);
app.use(adminRoutes);
app.use(billingRoutes);
app.use(communityRoutes);
app.use(spotifyRoutes);

app.use(errorHandler);
