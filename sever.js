import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { authRoutes } from "./routes/auth.js";
import { gameRoutes } from "./routes/game.js";
import { rewardRoutes } from "./routes/rewards.js";
import { referralRoutes } from "./routes/referrals.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";
import { withdrawalRoutes } from "./routes/withdrawals.js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Missing Words backend is running",
    version: "2.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok"
  });
});

authRoutes(app);
gameRoutes(app);
rewardRoutes(app);
referralRoutes(app);
leaderboardRoutes(app);
withdrawalRoutes(app);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.path
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

const PORT = Number(process.env.PORT || 10000);

app.listen(PORT, () => {
  console.log("==========================================");
  console.log("Missing Words backend");
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("==========================================");
});
