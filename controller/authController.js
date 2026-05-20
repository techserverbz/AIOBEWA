import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { db } from "../db/index.js";
import { users } from "../schema/users.js";
import { setOtp, consumeOtp, getOtpExpiryMinutes } from "../lib/otpStore.js";

const JWT_EXPIRY = "7d";
const BRAND = "WhatsApp Panel";

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const OTP_PURPOSE = {
  SIGNUP: "signup",
  FORGOT_PASSWORD: "forgot-password",
  FORGOT_USERNAME: "forgot-username",
};

const STRONG_PASSWORD_MESSAGE =
  "Use a strong password: at least 8 characters, uppercase, lowercase, number, and special character.";

function isStrongPassword(password) {
  if (!password || password.length < 8) return false;
  return (
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)
  );
}

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Server auth not configured");
  return jwt.sign({ userId: user.id, email: user.email, role: user.role }, secret, { expiresIn: JWT_EXPIRY });
}

/** Login with username/password or email/password. */
export async function login(req, res) {
  try {
    const loginId = String(req.body.username ?? req.body.email ?? "").trim();
    const password = String(req.body.password ?? "");
    if (!loginId || !password) {
      return res.status(400).json({ error: "Username/email and password are required" });
    }
    const isEmail = loginId.includes("@");
    const [user] = await db
      .select()
      .from(users)
      .where(isEmail ? eq(users.email, loginId.toLowerCase()) : eq(users.username, loginId))
      .limit(1);
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    if (user.isDisabled) return res.status(403).json({ error: "Account is disabled" });

    const storedHash = user.passwordHash || user.password;
    const valid = storedHash && (await bcrypt.compare(password, storedHash));
    if (!valid) return res.status(401).json({ error: "Invalid username or password" });

    const token = signToken(user);
    const { password: _p, passwordHash: _h, ...userSafe } = user;
    res.status(200).json({ token, user: userSafe });
  } catch (error) {
    console.error("[auth] login:", error);
    res.status(500).json({ error: error.message || "Login failed" });
  }
}

/** Send OTP to email for signup (email verification). */
export async function sendOtpSignup(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const { code } = setOtp(email, OTP_PURPOSE.SIGNUP);
    const expiryMin = getOtpExpiryMinutes();
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }
    const transporter = createTransporter();
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"${BRAND}" <${from}>`,
      to: email,
      subject: "Verify your email – signup code",
      text: `Your verification code is: ${code}. It expires in ${expiryMin} minutes.`,
      html: `<p>Your verification code is: <strong>${code}</strong>.</p><p>It expires in ${expiryMin} minutes.</p>`,
    });
    res.status(200).json({ message: "Verification code sent to your email" });
  } catch (error) {
    console.error("[auth] sendOtpSignup:", error);
    res.status(500).json({ error: error.message || "Failed to send code" });
  }
}

/** Sign up: verify OTP then create user (role 'user', no access until admin grants it). */
export async function signup(req, res) {
  try {
    const username = String(req.body.username ?? "").trim();
    const fullName = String(req.body.fullName ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const code = req.body?.code != null ? String(req.body.code) : "";

    if (!username || !fullName || !email || !password || !code.trim()) {
      return res.status(400).json({ error: "Username, full name, email, password and verification code are required" });
    }
    if (!consumeOtp(email, OTP_PURPOSE.SIGNUP, code)) {
      return res.status(401).json({
        error: "Invalid or expired verification code. Use the code from your most recent email.",
      });
    }
    const [existingUsername] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existingUsername) return res.status(409).json({ error: "Username already in use" });
    const [existingEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingEmail) return res.status(409).json({ error: "Email already registered" });
    if (!isStrongPassword(password)) return res.status(400).json({ error: STRONG_PASSWORD_MESSAGE });

    const hashedPassword = await bcrypt.hash(password, 10);
    const [created] = await db
      .insert(users)
      .values({ username, fullName, email, password: hashedPassword, passwordHash: hashedPassword, role: "user" })
      .returning();
    if (!created) return res.status(500).json({ error: "Error creating user" });

    const token = signToken(created);
    const { password: _p, passwordHash: _h, ...userSafe } = created;
    res.status(201).json({ token, user: userSafe });
  } catch (error) {
    console.error("[auth] signup:", error);
    res.status(500).json({ error: error.message || "Signup failed" });
  }
}

/** Send OTP for forgot password. */
export async function forgotPassword(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return res.status(404).json({ error: "No account found with this email." });
    if (user.isDisabled) return res.status(403).json({ error: "Account is disabled" });

    const { code } = setOtp(email, OTP_PURPOSE.FORGOT_PASSWORD);
    const expiryMin = getOtpExpiryMinutes();
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }
    const transporter = createTransporter();
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"${BRAND}" <${from}>`,
      to: email,
      subject: "Reset your password",
      text: `Your code is: ${code}. It expires in ${expiryMin} minutes.`,
      html: `<p>Your code is: <strong>${code}</strong>.</p><p>It expires in ${expiryMin} minutes.</p>`,
    });
    res.status(200).json({ message: "Code sent to your email" });
  } catch (error) {
    console.error("[auth] forgotPassword:", error);
    res.status(500).json({ error: error.message || "Failed to send code" });
  }
}

/** Reset password: verify OTP then set new password. */
export async function resetPassword(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const code = String(req.body.code ?? "").trim();
    const newPassword = String(req.body.newPassword ?? "");
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, code and new password are required" });
    }
    if (!isStrongPassword(newPassword)) return res.status(400).json({ error: STRONG_PASSWORD_MESSAGE });
    if (!consumeOtp(email, OTP_PURPOSE.FORGOT_PASSWORD, code)) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || user.isDisabled) return res.status(401).json({ error: "Invalid or expired code" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.update(users)
      .set({ password: hashedPassword, passwordHash: hashedPassword, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    res.status(200).json({ message: "Password updated. You can log in with your new password." });
  } catch (error) {
    console.error("[auth] resetPassword:", error);
    res.status(500).json({ error: error.message || "Reset failed" });
  }
}

/** Send OTP for forgot username. */
export async function forgotUsername(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return res.status(404).json({ error: "No account found with this email." });
    if (user.isDisabled) return res.status(403).json({ error: "Account is disabled" });

    const { code } = setOtp(email, OTP_PURPOSE.FORGOT_USERNAME);
    const expiryMin = getOtpExpiryMinutes();
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }
    const transporter = createTransporter();
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"${BRAND}" <${from}>`,
      to: email,
      subject: "Recover your username",
      text: `Your code is: ${code}. It expires in ${expiryMin} minutes.`,
      html: `<p>Your code is: <strong>${code}</strong>.</p><p>It expires in ${expiryMin} minutes.</p>`,
    });
    res.status(200).json({ message: "Code sent to your email" });
  } catch (error) {
    console.error("[auth] forgotUsername:", error);
    res.status(500).json({ error: error.message || "Failed to send code" });
  }
}

/** Recover username: verify OTP then return username. */
export async function recoverUsername(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const code = String(req.body.code ?? "").trim();
    if (!email || !code) return res.status(400).json({ error: "Email and code are required" });
    if (!consumeOtp(email, OTP_PURPOSE.FORGOT_USERNAME, code)) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || user.isDisabled) return res.status(401).json({ error: "Invalid or expired code" });
    res.status(200).json({ username: user.username });
  } catch (error) {
    console.error("[auth] recoverUsername:", error);
    res.status(500).json({ error: error.message || "Recovery failed" });
  }
}

export async function getMe(req, res) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : (req.query.token || null);
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Server auth not configured" });
    const decoded = jwt.verify(token, secret);
    const [user] = await db.select().from(users).where(eq(users.id, decoded.userId)).limit(1);
    if (!user || user.isDisabled) return res.status(401).json({ error: "Not authenticated" });
    const { password: _p, passwordHash: _h, ...rest } = user;
    res.json({ user: rest });
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.status(500).json({ error: error.message });
  }
}

/** PATCH /auth/me — update current user's profile. */
export async function updateMe(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const updates = {};
    if (req.body?.fullName != null) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return res.status(400).json({ error: "Full name is required" });
      updates.fullName = fullName;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No changes provided" });
    updates.updatedAt = new Date();
    const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
    if (!updated) return res.status(404).json({ error: "User not found" });
    const { password: _p, passwordHash: _h, ...safe } = updated;
    res.json({ user: safe });
  } catch (error) {
    console.error("[auth] updateMe:", error);
    res.status(500).json({ error: error.message || "Failed to update profile" });
  }
}
