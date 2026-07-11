import { Router } from "express";
import { buildHealthPayload, SHARED_APP_NAME } from "@shared/config/runtime";
import authRoutes from "./routes/auth";
import configRoutes from "./routes/config";
import domainRoutes from "./routes/domains";
import emailRoutes from "./routes/email";

const router = Router();

router.get("/health", (_req, res) => {
  res.json(buildHealthPayload("server"));
});

router.get("/config", (_req, res) => {
  res.json({
    app: SHARED_APP_NAME,
    version: process.env.APP_VERSION || "0.2.0",
    site: process.env.SITE || "new",
  });
});

// Auth routes
router.use("/auth", authRoutes);

// Config export/import routes
router.use("/config", configRoutes);

// Domain routes
router.use("/domains", domainRoutes);

// Email routes
router.use("/email", emailRoutes);

export default router;
