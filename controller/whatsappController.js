import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappMessages } from "../schema/whatsappMessages.js";
import { files } from "../schema/files.js";
import { whatsappManager } from "../lib/whatsappManager.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Fetch session and verify it belongs to the user's org */
async function getOrgSession(req) {
  const [session] = await db.select()
    .from(whatsappSessions)
    .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
    .limit(1);
  return session || null;
}

/** Check if user is the owner of the session */
function isOwner(session, userId) {
  return session.createdBy === userId;
}

// ─── Session CRUD ──────────────────────────────────────────────

/** GET /sessions — All members can see all sessions */
export async function listSessions(req, res) {
  try {
    // Auto-claim: assign unclaimed sessions (created_by IS NULL) to the requesting admin
    if (req.orgRole === "admin") {
      await db.update(whatsappSessions).set({ createdBy: req.user.id })
        .where(and(
          eq(whatsappSessions.organizationId, req.organizationId),
          isNull(whatsappSessions.createdBy),
        )).catch(() => {});
    }

    const rows = await db.select({
      id: whatsappSessions.id,
      type: whatsappSessions.type,
      sessionName: whatsappSessions.sessionName,
      phoneNumber: whatsappSessions.phoneNumber,
      scopeLevel: whatsappSessions.scopeLevel,
      scopeId: whatsappSessions.scopeId,
      connectionStatus: whatsappSessions.connectionStatus,
      lastConnected: whatsappSessions.lastConnected,
      lastError: whatsappSessions.lastError,
      createdBy: whatsappSessions.createdBy,
      createdAt: whatsappSessions.createdAt,
    })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.organizationId, req.organizationId))
      .orderBy(desc(whatsappSessions.createdAt));

    const enriched = rows.map((r) => ({
      ...r,
      isOwner: r.createdBy === req.user.id,
      clientReady: whatsappManager.isConnected(r.id),
    }));

    res.json({ sessions: enriched });
  } catch (err) {
    console.error("[WA] listSessions:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions — Any member can create (max 1 per member) */
export async function createSession(req, res) {
  try {
    const orgId = req.organizationId;
    const userId = req.user.id;

    // Check if user already has a session
    const [existing] = await db.select({ id: whatsappSessions.id })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.organizationId, orgId), eq(whatsappSessions.createdBy, userId)))
      .limit(1);
    if (existing)
      return res.status(409).json({ error: "You already have a WhatsApp session. Each member can only have one." });

    const sessionName = String(req.body.session_name ?? "").trim();
    if (!sessionName)
      return res.status(400).json({ error: "Session name is required" });

    // Check duplicate name
    const [nameTaken] = await db.select({ id: whatsappSessions.id })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.organizationId, orgId), eq(whatsappSessions.sessionName, sessionName)))
      .limit(1);
    if (nameTaken)
      return res.status(409).json({ error: "A session with this name already exists" });

    const [session] = await db.insert(whatsappSessions).values({
      organizationId: orgId,
      createdBy: userId,
      type: "wwebjs",
      sessionName,
      scopeLevel: req.body.scope_level || "org",
      scopeId: req.body.scope_id || null,
    }).returning();

    res.status(201).json(session);
  } catch (err) {
    console.error("[WA] createSession:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** DELETE /sessions/:id — Owner can delete own; admin can delete anyone's */
export async function deleteSession(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!isOwner(session, req.user.id) && req.orgRole !== "admin")
      return res.status(403).json({ error: "You can only delete your own session" });

    await whatsappManager.stopSession(session.id).catch(() => {});
    await db.delete(whatsappSessions).where(eq(whatsappSessions.id, session.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error("[WA] deleteSession:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Session Lifecycle (owner only) ─────────────────────────────

/** POST /sessions/:id/start — Owner only */
export async function startSession(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Only the session owner can start it" });

    await whatsappManager.startSession(session.id);
    res.json({ ok: true, message: "Session starting — poll /qr for QR code" });
  } catch (err) {
    console.error("[WA] startSession:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions/:id/stop — Owner only */
export async function stopSession(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Only the session owner can stop it" });

    await whatsappManager.stopSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[WA] stopSession:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/qr — Owner only */
export async function getQR(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const qr = whatsappManager.getQR(req.params.id);
    res.json({ qr, status: session.connectionStatus || "disconnected" });
  } catch (err) {
    console.error("[WA] getQR:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/status */
export async function getStatus(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });

    res.json({
      connectionStatus: session.connectionStatus,
      phoneNumber: session.phoneNumber,
      lastConnected: session.lastConnected,
      lastError: session.lastError,
    });
  } catch (err) {
    console.error("[WA] getStatus:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Messaging (owner only) ─────────────────────────────────────

/** POST /sessions/:id/send — Owner only */
export async function sendMessage(req, res) {
  try {
    const to = String(req.body.to ?? "").trim();
    const message = String(req.body.message ?? "").trim();
    if (!to) return res.status(400).json({ error: "Recipient number is required" });
    if (!message) return res.status(400).json({ error: "Message is required" });

    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const result = await whatsappManager.sendText(session.id, to, message);
    res.json({ ok: true, result: { id: result?.id?.id } });
  } catch (err) {
    console.error("[WA] sendMessage:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions/:id/send-media — Owner only */
export async function sendMedia(req, res) {
  try {
    const { to, file_url, file_name, mime_type, caption } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient number is required" });
    if (!file_url) return res.status(400).json({ error: "File URL is required" });

    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const result = await whatsappManager.sendMedia(
      session.id, to.trim(), file_url, file_name || "file", mime_type, caption
    );
    res.json({ ok: true, result: { id: result?.id?.id } });
  } catch (err) {
    console.error("[WA] sendMedia:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Message History (owner only) ───────────────────────────────

/** GET /sessions/:id/messages — Owner only */
export async function listMessages(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const rows = await db.select({
      id: whatsappMessages.id,
      messageId: whatsappMessages.messageId,
      fromNumber: whatsappMessages.fromNumber,
      fromJid: whatsappMessages.fromJid,
      toNumber: whatsappMessages.toNumber,
      messageType: whatsappMessages.messageType,
      content: whatsappMessages.content,
      fileId: whatsappMessages.fileId,
      fileUrl: files.fileUrl,
      fileName: files.fileName,
      direction: whatsappMessages.direction,
      status: whatsappMessages.status,
      createdAt: whatsappMessages.createdAt,
    })
      .from(whatsappMessages)
      .leftJoin(files, eq(whatsappMessages.fileId, files.id))
      .where(eq(whatsappMessages.sessionId, req.params.id))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(200);

    res.json({ messages: rows });
  } catch (err) {
    console.error("[WA] listMessages:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/chats — Owner only */
export async function getChats(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const limit = parseInt(req.query.limit) || 20;
    const chats = await whatsappManager.getChats(session.id, limit);
    res.json({ chats });
  } catch (err) {
    console.error("[WA] getChats:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/chats/:contactId — Owner only */
export async function getChatMessages(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const limit = parseInt(req.query.limit) || 50;
    const messages = await whatsappManager.getChatMessages(session.id, req.params.contactId, limit);
    res.json({ messages });
  } catch (err) {
    console.error("[WA] getChatMessages:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/media/:messageId — Owner only */
export async function streamMedia(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const media = await whatsappManager.getMedia(session.id, req.params.messageId);

    res.setHeader("Content-Type", media.mimetype);
    res.setHeader("Content-Length", media.data.length);
    res.setHeader("Content-Disposition", `inline; filename="${media.filename}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(media.data);
  } catch (err) {
    console.error("[WA] streamMedia:", err.message);
    res.status(err.message === "Message not found" ? 404 : 500).json({ error: err.message });
  }
}

/** POST /sessions/:id/media/:messageId/save — Owner only */
export async function saveMedia(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isOwner(session, req.user.id))
      return res.status(403).json({ error: "Not your session" });

    const title = req.body.title?.trim() || null;
    const description = req.body.description?.trim() || null;
    const result = await whatsappManager.saveMediaToS3(session.id, req.params.messageId, { title, description });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[WA] saveMedia:", err.message);
    res.status(500).json({ error: err.message });
  }
}
