import "./env";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import routes from "./routes";
import prisma from "./prisma";
import { API_PREFIX } from "@shared/config/runtime";
import { initCronJobs } from "./services/cronJobs";
import { logCertCheckProxyConfig } from "./services/certChecker";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ credentials: true }));
app.use(API_PREFIX, routes);

const candidateStaticDirs = [
  path.resolve(__dirname, "public"),
  path.resolve(__dirname, "../../client/dist"),
];
const staticDir = candidateStaticDirs.find((dir) => fs.existsSync(dir));

if (staticDir) {
  app.use(express.static(staticDir));

  app.get(/.*/, (req, res) => {
    if (path.extname(req.path)) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    res.sendFile("index.html", { root: staticDir });
  });
}

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log("Server listening on http://localhost:" + port);
  logCertCheckProxyConfig();
  initCronJobs();
});

async function shutdown(signal: string) {
  console.log("Received " + signal + "; shutting down...");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
