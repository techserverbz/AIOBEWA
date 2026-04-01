import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { users } from "../schema/users.js";

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
