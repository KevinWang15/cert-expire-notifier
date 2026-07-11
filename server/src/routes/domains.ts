import { Router, Response } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { updateDomainCertificateState } from "../services/domainCertificateState";
import { getDomainValidationError, normalizeDomain } from "../utils/domain";
import { normalizeNotes, parseStrictPositiveInt } from "../utils/validation";

const router = Router();
const CHECK_ALL_CONCURRENCY = 10;

// All routes require auth
router.use(authMiddleware);

// List all domains for the current user
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const domains = await prisma.domain.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ domains });
  } catch (err) {
    console.error("List domains error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add a new domain
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { domain, notes } = req.body;

    if (!domain) {
      res.status(400).json({ error: "Domain is required" });
      return;
    }

    const normalizedDomain = normalizeDomain(domain);
    const domainError = getDomainValidationError(normalizedDomain);
    if (domainError) {
      res.status(400).json({ error: domainError });
      return;
    }
    const normalizedDomainNotes = normalizeNotes(notes);

    const existing = await prisma.domain.findUnique({
      where: { userId_domain: { userId: req.userId!, domain: normalizedDomain } },
    });
    if (existing) {
      res.status(409).json({ error: "Domain already being monitored" });
      return;
    }

    const newDomain = await prisma.domain.create({
      data: {
        userId: req.userId!,
        domain: normalizedDomain,
        notes: normalizedDomainNotes,
      },
    });

    res.status(201).json({ domain: newDomain });
  } catch (err) {
    console.error("Add domain error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update a domain's notes
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const id = parseStrictPositiveInt(req.params.id);
    const normalizedDomainNotes = normalizeNotes(req.body.notes);

    if (id === null) {
      res.status(400).json({ error: "Invalid domain id" });
      return;
    }

    const domain = await prisma.domain.findFirst({
      where: { id, userId: req.userId },
    });
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const updated = await prisma.domain.update({
      where: { id },
      data: { notes: normalizedDomainNotes },
    });

    res.json({ domain: updated });
  } catch (err) {
    console.error("Update domain error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a domain
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const id = parseStrictPositiveInt(req.params.id);

    if (id === null) {
      res.status(400).json({ error: "Invalid domain id" });
      return;
    }

    const domain = await prisma.domain.findFirst({
      where: { id, userId: req.userId },
    });
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    await prisma.domain.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete domain error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manually check all domains for the current user
router.post("/check-all", async (req: AuthRequest, res: Response) => {
  try {
    const domains = await prisma.domain.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "asc" },
    });

    const updatedDomains: typeof domains = [];

    for (let index = 0; index < domains.length; index += CHECK_ALL_CONCURRENCY) {
      const batch = domains.slice(index, index + CHECK_ALL_CONCURRENCY);
      const updatedBatch = await Promise.all(
        batch.map(async (domain) => {
          return updateDomainCertificateState(domain.id, domain.domain);
        }),
      );

      updatedDomains.push(...updatedBatch);
    }

    res.json({ domains: updatedDomains, checked: updatedDomains.length });
  } catch (err) {
    console.error("Check all domains error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manually check a single domain's cert
router.post("/:id/check", async (req: AuthRequest, res: Response) => {
  try {
    const id = parseStrictPositiveInt(req.params.id);

    if (id === null) {
      res.status(400).json({ error: "Invalid domain id" });
      return;
    }

    const domain = await prisma.domain.findFirst({
      where: { id, userId: req.userId },
    });
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const updated = await updateDomainCertificateState(id, domain.domain);

    res.json({ domain: updated });
  } catch (err) {
    console.error("Check domain error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
