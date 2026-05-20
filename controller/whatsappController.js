import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappMessages } from "../schema/whatsappMessages.js";
import { files } from "../schema/files.js";
import { whatsappManager } from "../lib/whatsappManager.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Admin sees everything; otherwise the owner or a user the admin granted access. */
function canView(req, session) {
  return req.isAdmin || session.createdBy === req.user.id || (req.accessibleSessionIds?.has(session.id) ?? false);
}

/** Only admins and the session owner may manage (start/stop/delete/QR/save). */
function canManage(req, session) {
  return req.isAdmin || session.createdBy === req.user.id;
}

/** Fetch session, verify it belongs to the org AND the user may view it. */
async function getOrgSession(req) {
  const [session] = await db.select()
    .from(whatsappSessions)
    .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
    .limit(1);
  if (!session) return null;
  if (!canView(req, session)) return null;
  return session;
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
    if (req.isAdmin) {
      await db.update(whatsappSessions).set({ createdBy: req.user.id })
        .where(and(
          eq(whatsappSessions.organizationId, req.organizationId),
          isNull(whatsappSessions.createdBy),
        )).catch(() => {});
    }

    // Non-admins only see the business accounts the admin granted them.
    if (!req.isAdmin) {
      const ids = [...(req.accessibleSessionIds || [])];
      if (ids.length === 0) return res.json({ sessions: [] });
      req._sessionFilter = inArray(whatsappSessions.id, ids);
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
      .where(req._sessionFilter
        ? and(eq(whatsappSessions.organizationId, req.organizationId), req._sessionFilter)
        : eq(whatsappSessions.organizationId, req.organizationId))
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

/** POST /sessions — Admin only. The admin links business accounts and controls access. */
export async function createSession(req, res) {
  try {
    if (!req.isAdmin) {
      return res.status(403).json({ error: "Only an admin can link WhatsApp accounts" });
    }
    const orgId = req.organizationId;
    const userId = req.user.id;

    // Admin may link as many business accounts as needed (no per-user cap).
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

    if (!canManage(req, session))
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
    if (!canManage(req, session))
      return res.status(403).json({ error: "Admin or owner only" });

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
    if (!canManage(req, session))
      return res.status(403).json({ error: "Admin or owner only" });

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
    if (!canManage(req, session))
      return res.status(403).json({ error: "Admin or owner only" });

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
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

    const result = await whatsappManager.sendText(session.id, to, message);
    res.json({ ok: true, result: { id: result?.id?.id } });
  } catch (err) {
    console.error("[WA] sendMessage:", err.message);
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions/:id/send-media — Owner only.
 *  Accepts either multipart (file field + to/caption fields)
 *  OR JSON body { to, file_url, file_name, mime_type, caption }. */
export async function sendMedia(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

    const to = String(req.body.to ?? "").trim();
    const caption = req.body.caption || undefined;
    if (!to) return res.status(400).json({ error: "Recipient number is required" });

    if (req.file) {
      const buffer = req.file.buffer;
      const fileName = req.file.originalname || `upload-${Date.now()}`;
      const mimeType = req.file.mimetype || "application/octet-stream";
      const sendType = req.body.send_type || null; // 'ptt' for voice note, optional

      const result = await whatsappManager.sendMediaBuffer(
        session.id, to, buffer, fileName, mimeType, caption, { sendType }
      );
      return res.json({ ok: true, result: { id: result?.id?.id } });
    }

    const { file_url, file_name, mime_type } = req.body;
    if (!file_url) return res.status(400).json({ error: "File or file_url is required" });
    const result = await whatsappManager.sendMedia(
      session.id, to, file_url, file_name || "file", mime_type, caption
    );
    res.json({ ok: true, result: { id: result?.id?.id } });
  } catch (err) {
    console.error("[WA] sendMedia:", err.message);
    res.status(500).json({ error: err.message });
  }
}

export async function debugStore(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const client = whatsappManager.clients.get(session.id);
    if (!client) return res.status(400).json({ error: "Client not in memory" });
    const info = await client.pupPage.evaluate(() => {
      const out = {};
      out.hasStore = typeof window.Store;
      out.hasWWebJS = typeof window.WWebJS;
      out.storeKeys = window.Store ? Object.keys(window.Store).slice(0, 60) : [];
      out.storeKeyCount = window.Store ? Object.keys(window.Store).length : 0;
      out.cmKeys = window.Store?.ConversationMsgs ? Object.keys(window.Store.ConversationMsgs).slice(0, 40) : null;
      out.cmdKeys = window.Store?.Cmd ? Object.keys(window.Store.Cmd).filter((k) => /chat|msg|open|load/i.test(k)).slice(0, 60) : null;
      out.chatGet = typeof window.Store?.Chat?.get;
      out.widFactory = typeof window.Store?.WidFactory?.createWid;
      return out;
    });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function debugChatMessages(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const client = whatsappManager.clients.get(session.id);
    if (!client) return res.status(400).json({ error: "Client not in memory" });
    const out = await client.pupPage.evaluate(async (cid, phone) => {
      const log = [];
      try {
        const wid = window.Store.WidFactory.createWid(cid);
        const chat = window.Store.Chat.get(wid)
          || (await window.Store.FindOrCreateChat?.findOrCreateLatestChat(wid))?.chat;
        const ser = chat?.id?._serialized || cid;
        const lidNum = cid.split("@")[0];
        log.push("chat ser=" + ser + " phone=" + phone);

        const openDb = (name) => new Promise((res) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(null);
        });
        void lidNum; void phone;
        const idb = await openDb("model-storage");
        const tx = idb.transaction("message", "readonly");
        const os = tx.objectStore("message");
        // Find an image/video message for this chat and dump its thumbnail-ish fields.
        let raw = null;
        await new Promise((res) => {
          const range = IDBKeyRange.bound(`false_${ser}_`, `false_${ser}_￿`);
          const cur = os.openCursor(range);
          cur.onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return res();
            const v = c.value;
            if ((v?.type === "image" || v?.type === "video") && !raw) { raw = v; return res(); }
            c.continue();
          };
          cur.onerror = () => res();
        });
        idb.close();
        if (raw) {
          log.push("raw keys=" + Object.keys(raw).join(","));
          const t = raw.body || raw.clientThumbnail || raw.thumbnail;
          log.push("body type=" + typeof raw.body + " len=" + (raw.body ? String(raw.body).length : 0));
          log.push("has clientThumbnail=" + (!!raw.clientThumbnail) + " has thumbnail=" + (!!raw.thumbnail));
          log.push("body sample=" + (typeof t === "string" ? t.slice(0, 40) : JSON.stringify(t)?.slice(0, 80)));
          // Also check the hydrated model.
          const r = await window.Store.Msg.getMessagesById([raw.id]);
          const m = r?.messages?.[0];
          if (m) {
            log.push("model keys=" + Object.keys(m).slice(0, 40).join(","));
            log.push("model.body len=" + (m.body ? m.body.length : 0) + " mediaData=" + (m.mediaData ? Object.keys(m.mediaData).join("|") : "none"));
          }
        } else {
          log.push("no image/video msg found for chat");
        }
      } catch (e) {
        log.push("outer err: " + e.message);
      }
      return { log };
    }, req.params.contactId, req.query.phone || "");
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions/:id/backfill — refresh chats from live wwebjs into memory cache. */
export async function backfill(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });
    whatsappManager.invalidateChatCache?.(session.id);
    const chats = await whatsappManager.getChats(session.id, 200);
    res.json({ ok: true, inserted: chats.length });
  } catch (err) {
    console.error("[WA] backfill:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Message History (owner only) ───────────────────────────────

/** GET /sessions/:id/messages — Owner only */
export async function listMessages(req, res) {
  try {
    const session = await getOrgSession(req);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

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
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

    const limit = parseInt(req.query.limit) || 20;
    try {
      const chats = await whatsappManager.getChats(session.id, limit);
      return res.json({ chats });
    } catch (err) {
      // Client not ready yet (still syncing after QR scan) — return empty so UI shows "loading"
      if (/Session not connected|getChats|Target closed|Execution context/i.test(err.message)) {
        return res.json({ chats: [], syncing: true });
      }
      throw err;
    }
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
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

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
    if (!canView(req, session))
      return res.status(403).json({ error: "No access to this account" });

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
    if (!canManage(req, session))
      return res.status(403).json({ error: "Admin or owner only" });

    const title = req.body.title?.trim() || null;
    const description = req.body.description?.trim() || null;
    const result = await whatsappManager.saveMediaToS3(session.id, req.params.messageId, { title, description });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[WA] saveMedia:", err.message);
    res.status(500).json({ error: err.message });
  }
}
