import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../prisma";
import { generateToken, authMiddleware, AuthRequest } from "../middleware/auth";
import { emailRateLimitKey, rateLimit } from "../middleware/rateLimit";
import { sendTrackedEmail } from "../services/emailService";
import { escapeHtml } from "../utils/html";
import { createRawToken, hashToken, minutesFromNow, parsePositiveInt } from "../utils/tokens";
import { getPublicAppUrl } from "../utils/url";
import { normalizeName } from "../utils/validation";

const router = Router();
const EMAIL_VERIFICATION_TTL_MINUTES = parsePositiveInt(
  process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES,
  60 * 24,
);
const PASSWORD_RESET_TTL_MINUTES = parsePositiveInt(
  process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES,
  60,
);
const MIN_PASSWORD_LENGTH = 8;
const loginRateLimit = rateLimit({
  bucket: "auth-login",
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: "Too many login attempts. Please try again later.",
  key: emailRateLimitKey,
});
const emailActionRateLimit = rateLimit({
  bucket: "auth-email-action",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  message: "Too many requests for this email address. Please try again later.",
  key: emailRateLimitKey,
});

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getNameValidationError(name: string | null): string | null {
  if (!name) {
    return "Name is required";
  }
  return null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getPasswordValidationError(password: unknown): string | null {
  if (typeof password !== "string") {
    return "Password is required";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

function includeDevUrl(url: string): string | undefined {
  return process.env.NODE_ENV !== "production" ? url : undefined;
}

function formatExpiry(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

async function createVerificationToken(userId: number) {
  await prisma.emailVerificationToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = createRawToken();
  const expiresAt = minutesFromNow(EMAIL_VERIFICATION_TTL_MINUTES);

  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

async function createPasswordResetToken(userId: number) {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = createRawToken();
  const expiresAt = minutesFromNow(PASSWORD_RESET_TTL_MINUTES);

  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

function verificationEmailHtml(name: string | null, email: string, url: string): string {
  const displayName = escapeHtml(name || email);
  const safeUrl = escapeHtml(url);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">Verify your Cert Expire Notifier account</h2>
      <p>Hello ${displayName},</p>
      <p>Confirm this email address before signing in and receiving certificate alerts.</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="background: #0f172a; color: #fff; padding: 12px 18px; border-radius: 12px; text-decoration: none; font-weight: 700; display: inline-block;">Verify email</a>
      </p>
      <p>If the button does not work, paste this link into your browser:</p>
      <p style="word-break: break-all; font-size: 13px; color: #475569;">${safeUrl}</p>
      <p style="font-size: 13px; color: #64748b;">This link expires in ${formatExpiry(EMAIL_VERIFICATION_TTL_MINUTES)}.</p>
    </div>
  `;
}

function passwordResetEmailHtml(name: string | null, email: string, url: string): string {
  const displayName = escapeHtml(name || email);
  const safeUrl = escapeHtml(url);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">Reset your Cert Expire Notifier password</h2>
      <p>Hello ${displayName},</p>
      <p>Use this secure link to choose a new password for your account.</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="background: #0f172a; color: #fff; padding: 12px 18px; border-radius: 12px; text-decoration: none; font-weight: 700; display: inline-block;">Reset password</a>
      </p>
      <p>If you did not request this, you can ignore this email.</p>
      <p style="word-break: break-all; font-size: 13px; color: #475569;">${safeUrl}</p>
      <p style="font-size: 13px; color: #64748b;">This link expires in ${formatExpiry(PASSWORD_RESET_TTL_MINUTES)}.</p>
    </div>
  `;
}

async function sendVerificationEmail(
  user: { id: number; email: string; name: string | null },
  req: Request,
) {
  const { token, expiresAt } = await createVerificationToken(user.id);
  const verificationUrl = `${getPublicAppUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
  const delivery = await sendTrackedEmail(
    {
      userId: user.id,
      to: user.email,
      subject: "Verify your Cert Expire Notifier email",
      purpose: "VERIFY_EMAIL",
      html: verificationEmailHtml(user.name, user.email, verificationUrl),
      preview: `Verification email expires at ${expiresAt.toISOString()}`,
    },
    { throwOnFailure: false },
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(`[Auth] Verification link for ${user.email}: ${verificationUrl}`);
  }

  return { delivery, verificationUrl, expiresAt };
}

async function sendPasswordResetEmail(
  user: { id: number; email: string; name: string | null },
  req: Request,
) {
  const { token, expiresAt } = await createPasswordResetToken(user.id);
  const resetUrl = `${getPublicAppUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const delivery = await sendTrackedEmail(
    {
      userId: user.id,
      to: user.email,
      subject: "Reset your Cert Expire Notifier password",
      purpose: "PASSWORD_RESET",
      html: passwordResetEmailHtml(user.name, user.email, resetUrl),
      preview: `Password reset email expires at ${expiresAt.toISOString()}`,
    },
    { throwOnFailure: false },
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(`[Auth] Password reset link for ${user.email}: ${resetUrl}`);
  }

  return { delivery, resetUrl, expiresAt };
}

router.post("/signup", emailActionRateLimit, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    const name = normalizeName(req.body.name);

    if (!email || !isValidEmail(email)) {
      res.status(400).json({ error: "A valid email is required" });
      return;
    }

    const nameError = getNameValidationError(name);
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      res.status(400).json({ error: passwordError });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({
        error:
          "Email already registered. Sign in, reset your password, or request a new verification email.",
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, emailVerifiedAt: null },
      select: { id: true, email: true, name: true },
    });

    const { delivery, verificationUrl } = await sendVerificationEmail(user, req);

    res.status(201).json({
      success: true,
      message:
        delivery.status === "SENT"
          ? "Account created. Check your inbox to verify your email before signing in."
          : "Account created, but the verification email could not be delivered. You can resend it after email delivery is configured.",
      email,
      emailDeliveryStatus: delivery.status,
      devVerificationUrl: includeDevUrl(verificationUrl),
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", loginRateLimit, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!email || typeof password !== "string" || password.length === 0) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (!user.emailVerifiedAt) {
      res.status(403).json({
        error: "Please verify your email before signing in.",
        code: "EMAIL_NOT_VERIFIED",
      });
      return;
    }

    const token = generateToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerifiedAt: user.emailVerifiedAt,
        notificationThresholdDays: user.notificationThresholdDays,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/resend-verification", emailActionRateLimit, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    let devVerificationUrl: string | undefined;

    if (email && isValidEmail(email)) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          name: true,
          emailVerifiedAt: true,
          notificationThresholdDays: true,
        },
      });

      if (user && !user.emailVerifiedAt) {
        const result = await sendVerificationEmail(user, req);
        devVerificationUrl = includeDevUrl(result.verificationUrl);
      }
    }

    res.json({
      success: true,
      message: "If an unverified account exists for that email, a new verification link was sent.",
      devVerificationUrl,
    });
  } catch (err) {
    console.error("Resend verification error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/verify-email", async (req: Request, res: Response) => {
  try {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    if (!token) {
      res.status(400).json({ error: "Verification token is required" });
      return;
    }

    const tokenRecord = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: "Verification link is invalid or expired" });
      return;
    }

    const claimedAt = new Date();
    const claimed = await prisma.emailVerificationToken.updateMany({
      where: {
        id: tokenRecord.id,
        usedAt: null,
        expiresAt: { gt: claimedAt },
      },
      data: { usedAt: claimedAt },
    });

    if (claimed.count !== 1) {
      res.status(400).json({ error: "Verification link is invalid or expired" });
      return;
    }

    const verifiedAt = tokenRecord.user.emailVerifiedAt || claimedAt;
    const user = await prisma.user.update({
      where: { id: tokenRecord.userId },
      data: { emailVerifiedAt: verifiedAt },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
        notificationThresholdDays: true,
      },
    });

    res.json({
      success: true,
      message: "Email verified successfully.",
      token: generateToken(user.id),
      user,
    });
  } catch (err) {
    console.error("Verify email error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/forgot-password", emailActionRateLimit, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    let devResetUrl: string | undefined;

    if (email && isValidEmail(email)) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, name: true },
      });

      if (user) {
        const result = await sendPasswordResetEmail(user, req);
        devResetUrl = includeDevUrl(result.resetUrl);
      }
    }

    res.json({
      success: true,
      message: "If an account exists for that email, a password reset link was sent.",
      devResetUrl,
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/reset-password", async (req: Request, res: Response) => {
  try {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password = req.body.password;

    if (!token) {
      res.status(400).json({ error: "Reset token is required" });
      return;
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      res.status(400).json({ error: passwordError });
      return;
    }

    const tokenRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: "Password reset link is invalid or expired" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const claimedAt = new Date();
    const claimed = await prisma.passwordResetToken.updateMany({
      where: {
        id: tokenRecord.id,
        usedAt: null,
        expiresAt: { gt: claimedAt },
      },
      data: { usedAt: claimedAt },
    });

    if (claimed.count !== 1) {
      res.status(400).json({ error: "Password reset link is invalid or expired" });
      return;
    }

    await prisma.user.update({
      where: { id: tokenRecord.userId },
      data: {
        password: hashedPassword,
        emailVerifiedAt: tokenRecord.user.emailVerifiedAt || claimedAt,
      },
    });

    res.json({ success: true, message: "Password reset successfully. You can sign in now." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
        notificationThresholdDays: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
