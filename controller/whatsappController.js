import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappMessages } from "../schema/whatsappMessages.js";
import { whatsappKeys } from "../schema/whatsappKeys.js";
import { files } from "../schema/files.js";
import { whatsappManager } from "../lib/whatsappManager.js";

/** GET /org/whatsapp/sessions — List all sessions for org */
export async function listSessions(req, res) {
  try {
    const orgId = req.organizationId;
    const rows = await db
      .select({
        id: whatsappSessions.id,
        type: whatsappSessions.type,
        sessionName: whatsappSessions.sessionName,
        phoneNumber: whatsappSessions.phoneNumber,
        scopeLevel: whatsappSessions.scopeLevel,
        scopeId: whatsappSessions.scopeId,
        connectionStatus: whatsappSessions.connectionStatus,
        lastConnected: whatsappSessions.lastConnected,
        lastError: whatsappSessions.lastError,
        createdAt: whatsappSessions.createdAt,
      })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.organizationId, orgId))
      .orderBy(desc(whatsappSessions.createdAt));
    res.json({ sessions: rows });
  } catch (err) {
    console.error("List WA sessions error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /org/whatsapp/sessions — Create new session */
export async function createSession(req, res) {
  try {
    if (req.orgRole !== "admin")
      return res.status(403).json({ error: "Only admin can create WhatsApp sessions" });

    const orgId = req.organizationId;
    const type = String(req.body.type ?? "").toLowerCase();
    const sessionName = String(req.body.session_name ?? "").trim();

    if (!["baileys", "wwebjs", "official"].includes(type))
      return res.status(400).json({ error: "Type must be 'baileys', 'wwebjs', or 'official'" });
    if (!sessionName)
      return res.status(400).json({ error: "Session name is required" });

    // Check unique name per org
    const [existing] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.organizationId, orgId), eq(whatsappSessions.sessionName, sessionName)))
      .limit(1);
    if (existing)
      return res.status(409).json({ error: "A session with this name already exists" });

    const scopeLevel = req.body.scope_level || "org";
    const scopeId = req.body.scope_id || null;

    const values = {
      organizationId: orgId,
      type,
      sessionName,
      scopeLevel,
      scopeId,
    };

    // Official API — save tokens
    if (type === "official") {
      values.accessToken = req.body.access_token?.trim() || null;
      values.phoneNumberId = req.body.phone_number_id?.trim() || null;
      values.wabaId = req.body.waba_id?.trim() || null;
      values.webhookVerifyToken = req.body.webhook_verify_token?.trim() || null;
      if (!values.accessToken || !values.phoneNumberId)
        return res.status(400).json({ error: "Access token and phone number ID are required for official API" });
    }

    const [session] = await db.insert(whatsappSessions).values(values).returning();
    res.status(201).json(session);
  } catch (err) {
    console.error("Create WA session error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /org/whatsapp/sessions/:id/start — Start/connect session */
export async function startSession(req, res) {
  try {
    if (req.orgRole !== "admin")
      return res.status(403).json({ error: "Only admin can start sessions" });

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    await whatsappManager.startSession(session.id);
    res.json({ ok: true, message: session.type === "baileys" ? "Session starting — poll /qr for QR code" : "Connected" });
  } catch (err) {
    console.error("Start WA session error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /org/whatsapp/sessions/:id/stop — Disconnect session */
export async function stopSession(req, res) {
  try {
    if (req.orgRole !== "admin")
      return res.status(403).json({ error: "Only admin can stop sessions" });

    await whatsappManager.stopSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Stop WA session error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /org/whatsapp/sessions/:id/qr — Get QR code (Baileys only) */
export async function getQR(req, res) {
  try {
    const qr = whatsappManager.getQR(req.params.id);
    const [session] = await db
      .select({ connectionStatus: whatsappSessions.connectionStatus })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, req.params.id))
      .limit(1);

    res.json({
      qr, // data URL or null
      status: session?.connectionStatus || "disconnected",
    });
  } catch (err) {
    console.error("Get QR error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /org/whatsapp/sessions/:id/status — Connection status */
export async function getStatus(req, res) {
  try {
    const [session] = await db
      .select({
        connectionStatus: whatsappSessions.connectionStatus,
        phoneNumber: whatsappSessions.phoneNumber,
        lastConnected: whatsappSessions.lastConnected,
        lastError: whatsappSessions.lastError,
      })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (err) {
    console.error("Get WA status error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /org/whatsapp/sessions/:id/send — Send message */
export async function sendMessage(req, res) {
  try {
    const to = String(req.body.to ?? "").trim();
    const message = String(req.body.message ?? "").trim();
    if (!to) return res.status(400).json({ error: "Recipient number is required" });
    if (!message) return res.status(400).json({ error: "Message is required" });

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const result = await whatsappManager.sendMessage(session.id, to, message);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Send WA message error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /sessions/:id/send-media — Send media file */
export async function sendMedia(req, res) {
  try {
    const { to, file_url, file_name, mime_type, caption } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient number is required" });
    if (!file_url) return res.status(400).json({ error: "File URL is required" });

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const result = await whatsappManager.sendMediaMessage(
      session.id, to.trim(), file_url, file_name || "file", mime_type, caption
    );
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Send media error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/messages — Message history */
export async function listMessages(req, res) {
  try {
    const [session] = await db
      .select({ id: whatsappSessions.id })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const rows = await db
      .select({
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
    console.error("List WA messages error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/chats — Recent conversations (wwebjs only) */
export async function getChats(req, res) {
  try {
    const [session] = await db
      .select({ id: whatsappSessions.id, type: whatsappSessions.type })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.type !== "wwebjs") return res.status(400).json({ error: "Chat history is only available for whatsapp-web.js sessions" });

    const limit = parseInt(req.query.limit) || 20;
    const chats = await whatsappManager.getRecentChats(session.id, limit);
    res.json({ chats });
  } catch (err) {
    console.error("Get chats error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sessions/:id/chats/:contactId — Messages from a specific chat (wwebjs only) */
export async function getChatMessages(req, res) {
  try {
    const [session] = await db
      .select({ id: whatsappSessions.id, type: whatsappSessions.type })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.type !== "wwebjs") return res.status(400).json({ error: "Chat history is only available for whatsapp-web.js sessions" });

    const limit = parseInt(req.query.limit) || 50;
    const messages = await whatsappManager.getChatMessages(session.id, req.params.contactId, limit);
    res.json({ messages });
  } catch (err) {
    console.error("Get chat messages error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** DELETE /org/whatsapp/sessions/:id — Delete session + all data */
export async function deleteSession(req, res) {
  try {
    if (req.orgRole !== "admin")
      return res.status(403).json({ error: "Only admin can delete sessions" });

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, req.params.id), eq(whatsappSessions.organizationId, req.organizationId)))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Stop if running
    await whatsappManager.stopSession(session.id).catch(() => {});

    // Cascade delete handles keys + messages
    await db.delete(whatsappSessions).where(eq(whatsappSessions.id, session.id));
    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete WA session error:", err);
    res.status(500).json({ error: err.message });
  }
}

/** POST /whatsapp/webhook — Meta webhook for official API */
export async function handleWebhook(req, res) {
  // Webhook verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token) {
      // Find session with matching verify token
      const [session] = await db
        .select()
        .from(whatsappSessions)
        .where(eq(whatsappSessions.webhookVerifyToken, token))
        .limit(1);
      if (session) return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // Incoming message webhook (POST)
  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (value?.messages) {
      for (const msg of value.messages) {
        // Find session by phone_number_id
        const phoneNumberId = value.metadata?.phone_number_id;
        const [session] = await db
          .select()
          .from(whatsappSessions)
          .where(eq(whatsappSessions.phoneNumberId, phoneNumberId))
          .limit(1);

        if (session) {
          await db.insert(whatsappMessages).values({
            sessionId: session.id,
            messageId: msg.id || `wh_${Date.now()}`,
            fromNumber: msg.from,
            toNumber: value.metadata?.display_phone_number || "business",
            messageType: msg.type || "text",
            content: msg.text?.body || msg.caption || null,
            direction: "inbound",
            status: "received",
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200); // Always 200 to Meta
  }
}
