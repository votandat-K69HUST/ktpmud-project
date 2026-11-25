import express from "express";
import cors from "cors";
import compression from "compression";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createUsersRouter } from "./routes/users.routes.js";
import { createOwnerPitchesRouter } from "./routes/ownerPitches.routes.js";
import { createPitchesRouter } from "./routes/pitches.routes.js";
import { createBookingsRouter } from "./routes/bookings.routes.js";
import { createOwnerBookingsRouter } from "./routes/ownerBookings.routes.js";
import { createReviewsCommentsRouter } from "./routes/reviewsComments.routes.js";
import { createOwnerRevenueRouter } from "./routes/ownerRevenue.routes.js";
import { createCompatRouter } from "./routes/compat.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp(pool) {
  const app = express();

  const corsOriginEnv = process.env.CORS_ORIGIN;
  const corsOriginOption =
    !corsOriginEnv || corsOriginEnv === "*" || corsOriginEnv === "http://localhost:5173"
      ? true
      : corsOriginEnv.split(",").map((s) => s.trim());

  app.use(
    cors({
      origin: corsOriginOption,
      credentials: true,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: "2mb" }));

  // Healthcheck
  app.get("/api/v1/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "UP", database: "PostgreSQL", scope: "Branches 1, 2, 4" });
    } catch (err) {
      res.status(503).json({ status: "DOWN", error: err.message });
    }
  });

  // Branch 1: Auth & Users
  app.use("/api/v1/auth", createAuthRouter(pool));
  app.use("/api/v1", createUsersRouter(pool));

  // Branch 4: Owner Pitches, Slots, Bank Accounts & Revenue
  app.use("/api/v1/owner", createOwnerPitchesRouter(pool));
  app.use("/api/v1/owner", createOwnerRevenueRouter(pool));

  // Branch 2: Public Pitches, Bookings, Deposit, Reviews & Comments
  app.use("/api/v1", createPitchesRouter(pool));
  app.use("/api/v1/bookings", createBookingsRouter(pool));
  app.use("/api/v1/owner/bookings", createOwnerBookingsRouter(pool));
  app.use("/api/v1", createReviewsCommentsRouter(pool));

  // Frontend Compatibility Adapter Routes (backed 100% by PostgreSQL Neon DB)
  app.use("/api/v1", createCompatRouter(pool));

  app.use(errorHandler);
  return app;
}
