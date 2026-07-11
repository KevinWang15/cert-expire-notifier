import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  userId?: number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }

  return secret || "dev-secret-change-me";
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as { userId?: unknown };
    if (typeof decoded.userId !== "number") {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: "30d" });
}
