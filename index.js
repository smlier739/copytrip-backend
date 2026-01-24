// backend/index.js – Grenseløs Reise backend (ESM)
import dotenv from "dotenv";
dotenv.config({ override: true });

import express from "express";
import cors from "cors";

import adminRoutes from "./routes/admin.js";
import adminGrenselosRouter from "./routes/adminGrenselos.js";

import johnnysTipsRouter from "./routes/johnnysTips.js";
import carRentalsRouter from "./routes/carRentals.js";
import bikeRentalsRouter from "./routes/bikeRentals.js";
import flightsRouter from "./routes/flights.js";
import locationsRouter from "./routes/locations.js";
import experiencesRouter from "./routes/experiences.js";
import hotelsRouter from "./routes/hotels.js";
import tripsRouter from "./routes/trips.js";
import communityRouter from "./routes/community.js";
import aiRouter from "./routes/ai.js";
import authRouter from "./routes/auth.js";
import debugRouter from "./routes/debug.js";
import grenselosRouter from "./routes/grenselos.js";
import profileRouter from "./routes/profile.js";

import { uploadDir } from "./services/uploads/communityUploads.js";
import { errorHandler } from "./middleware/errorHandler.js";

// ---------------------------------
// App
// ---------------------------------
const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check (må være før errorHandler)
app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// ---------------------------------
// Request logging (før routes)
// ---------------------------------
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    console.log("➡️", req.method, req.originalUrl);
    next();
  });
}

// ---------------------------------
// Static: uploads
// ---------------------------------
app.use("/uploads", express.static(uploadDir));

// ---------------------------------
// Routes
// ---------------------------------
app.use("/api/auth", authRouter);
app.use("/api/profile", profileRouter);

app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminGrenselosRouter);

app.use("/api/johnnys-tips", johnnysTipsRouter);
app.use("/api/community", communityRouter);

app.use("/api", carRentalsRouter);
app.use("/api", bikeRentalsRouter);
app.use("/api", flightsRouter);
app.use("/api", locationsRouter);
app.use("/api", experiencesRouter);
app.use("/api", hotelsRouter);

app.use("/api/trips", tripsRouter);
app.use("/api/ai", aiRouter);
app.use("/api/debug", debugRouter);
app.use("/api/grenselos", grenselosRouter);

// ---------------------------------
// 404
// ---------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---------------------------------
// Error handler (sist)
// ---------------------------------
app.use(errorHandler);

// ---------------------------------
// Server start
// ---------------------------------
const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`🚀 Grenseløs Reise backend kjører på port ${PORT}`);
});

export default app;
