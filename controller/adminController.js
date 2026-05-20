import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../schema/users.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { sessionAccess } from "../schema/sessionAccess.js";
import { whatsappManager } from "../lib/whatsappManager.js";

/** GET /admin/users — list all users (admin only). */
export async function listUsers(req, res) {
  try {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
        isDisabled: users.isDisabled,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    res.json({ users: rows });
  } catch (err) {
    console.error("[admin] listUsers:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /admin/accounts — list all WhatsApp business accounts (sessions). */
export async function listAccounts(req, res) {
  try {
    const rows = await db
      .select({
        id: whatsappSessions.id,
        sessionName: whatsappSessions.sessionName,
        phoneNumber: whatsappSessions.phoneNumber,
        connectionStatus: whatsappSessions.connectionStatus,
        createdAt: whatsappSessions.createdAt,
      })
      .from(whatsappSessions)
      .orderBy(desc(whatsappSessions.createdAt));
    const enriched = rows.map((r) => ({ ...r, clientReady: whatsappManager.isConnected(r.id) }));
    res.json({ accounts: enriched });
  } catch (err) {
    console.error("[admin] listAccounts:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /admin/users/:userId/access — session ids this user can view. */
export async function getUserAccess(req, res) {
  try {
    const rows = await db
      .select({ sessionId: sessionAccess.sessionId })
      .from(sessionAccess)
      .where(eq(sessionAccess.userId, req.params.userId));
    res.json({ sessionIds: rows.map((r) => r.sessionId) });
  } catch (err) {
    console.error("[admin] getUserAccess:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** PUT /admin/users/:userId/access  body: { sessionIds: string[] } — replace grants. */
export async function setUserAccess(req, res) {
  try {
    const userId = req.params.userId;
    const sessionIds = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Replace the whole set: delete existing, insert the new list.
    await db.delete(sessionAccess).where(eq(sessionAccess.userId, userId));
    if (sessionIds.length) {
      await db
        .insert(sessionAccess)
        .values(sessionIds.map((sid) => ({ userId, sessionId: sid })))
        .onConflictDoNothing();
    }
    res.json({ ok: true, sessionIds });
  } catch (err) {
    console.error("[admin] setUserAccess:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** PATCH /admin/users/:userId  body: { role?, isDisabled? } */
export async function updateUser(req, res) {
  try {
    const userId = req.params.userId;
    if (userId === req.user.id) {
      return res.status(400).json({ error: "You cannot change your own admin account here" });
    }
    const updates = {};
    if (req.body?.role === "admin" || req.body?.role === "user") updates.role = req.body.role;
    if (typeof req.body?.isDisabled === "boolean") updates.isDisabled = req.body.isDisabled;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No changes provided" });
    updates.updatedAt = new Date();
    const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
    if (!updated) return res.status(404).json({ error: "User not found" });
    const { password: _p, passwordHash: _h, ...safe } = updated;
    res.json({ user: safe });
  } catch (err) {
    console.error("[admin] updateUser:", err.message);
    res.status(500).json({ error: err.message });
  }
}
