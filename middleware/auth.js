import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../schema/users.js";

// Real auth is now required. Set DEV_AUTH=true in .env only for local no-login testing.
const DEV_AUTH = process.env.DEV_AUTH === "true";
let _devUserCache = null;

async function getOrCreateDevUser() {
  if (_devUserCache) return _devUserCache;
  const email = "dev@localhost";
  let [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!u) {
    await db.execute(
      dsql`INSERT INTO users (email, name) VALUES (${email}, ${"Dev User"}) ON CONFLICT (email) DO NOTHING`
    );
    [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  }
  _devUserCache = u;
  return u;
}

/**
 * Require valid JWT; sets req.user (id, username, email, etc. — no password).
 * Use on org and CRM routes that require login.
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    // Support token via query param for media streaming (img/video/audio src can't set headers)
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : (req.query.token || null);
    if (!token) {
      if (DEV_AUTH) {
        const u = await getOrCreateDevUser();
        const { password: _p, passwordHash: _h, ...rest } = u;
        req.user = rest;
        return next();
      }
      return res.status(401).json({ error: "Not authenticated" });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Server auth not configured" });
    }
    const decoded = jwt.verify(token, secret);
    const [user] = await db.select().from(users).where(eq(users.id, decoded.userId)).limit(1);
    if (!user || user.isDisabled) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const { password: _p, passwordHash: _h, ...rest } = user;
    req.user = rest;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Not authenticated" });
    }
    next(err);
  }
}

/** Require the authenticated user to be an admin. Attach after requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
