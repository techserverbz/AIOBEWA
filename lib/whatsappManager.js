import { eq } from "drizzle-orm";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import pkg from "whatsapp-web.js";
const { Client: WWJSClient, LocalAuth: WWJSLocalAuth } = pkg;
import QRCode from "qrcode";
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappMessages } from "../schema/whatsappMessages.js";
import { files } from "../schema/files.js";
import { useDatabaseAuthState } from "./whatsappAuthStore.js";

const S3_SIGNED_URL_ENDPOINT = "https://wkgijoo8il.execute-api.ap-south-1.amazonaws.com/prod/gsu";
const S3_BUCKET = "server-sided-s3";
const S3_REGION = "ap-south-1";

/** Upload a buffer to S3 via signed URL and save to files table */
async function uploadMediaToS3(buffer, fileName, mimeType, orgId, userId, sessionId) {
  try {
    const date = new Date();
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const key = `whatsapp/${orgId}/media/${y}/${mo}/${d}/${sessionId}/${fileName}`;

    // Get signed URL
    const signedRes = await fetch(S3_SIGNED_URL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: S3_BUCKET, account: "SHUBHAM", key1: key, Expires: 300 }),
    });
    const { signedUrl } = await signedRes.json();

    // Upload to S3
    await fetch(signedUrl, {
      method: "PUT",
      body: buffer,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const fileUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodedKey}`;

    // Save to files table
    const [fileRecord] = await db.insert(files).values({
      organizationId: orgId,
      uploadedBy: userId || null,
      fileName,
      fileKey: key,
      fileUrl,
      fileType: mimeType || null,
      fileSize: buffer.length || null,
      folder: "whatsapp",
    }).returning();

    return fileRecord;
  } catch (err) {
    console.error("[WhatsApp] Media upload failed:", err.message);
    return null;
  }
}

class WhatsAppManager {
  constructor() {
    /** @type {Map<string, any>} session ID → WASocket (baileys) or WWJSClient (wwebjs) */
    this.connections = new Map();
    /** @type {Map<string, string>} session ID → QR data URL */
    this.qrCodes = new Map();
    /** @type {Map<string, WWJSClient>} wwebjs clients */
    this.wwejsClients = new Map();
  }

  // ─── Baileys Engine ───

  async startBaileysSession(sessionId) {
    if (this.connections.has(sessionId)) return;

    await this._updateStatus(sessionId, "connecting");

    const { state, saveCreds } = await useDatabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      defaultQueryTimeoutMs: 60000,
    });

    this.connections.set(sessionId, sock);

    // Connection updates (QR, connected, disconnected)
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        this.qrCodes.set(sessionId, qrDataUrl);
        await this._updateStatus(sessionId, "connecting");
      }

      if (connection === "open") {
        this.qrCodes.delete(sessionId);
        const phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id || null;
        await db
          .update(whatsappSessions)
          .set({
            connectionStatus: "connected",
            phoneNumber,
            lastConnected: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(whatsappSessions.id, sessionId));
        console.log(`[WhatsApp] Session ${sessionId} connected as ${phoneNumber}`);
      }

      if (connection === "close") {
        this.connections.delete(sessionId);
        this.qrCodes.delete(sessionId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const errorMsg = lastDisconnect?.error?.message || "Connection closed";

        await db
          .update(whatsappSessions)
          .set({
            connectionStatus: "disconnected",
            lastError: errorMsg,
            updatedAt: new Date(),
          })
          .where(eq(whatsappSessions.id, sessionId));

        if (shouldReconnect) {
          console.log(`[WhatsApp] Session ${sessionId} reconnecting...`);
          setTimeout(() => this.startBaileysSession(sessionId), 3000);
        } else {
          console.log(`[WhatsApp] Session ${sessionId} logged out`);
        }
      }
    });

    // Save creds on update
    sock.ev.on("creds.update", saveCreds);

    // Incoming messages
    sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      if (type !== "notify") return;
      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;
        try {
          const msgType = Object.keys(msg.message)[0] || "unknown";
          const textContent =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            null;

          // Extract phone number from JID
          const rawJid = msg.key.remoteJid || "unknown";
          const pushName = msg.pushName || null;
          let fromNumber = "unknown";

          if (rawJid.endsWith("@s.whatsapp.net")) {
            // Normal JID — phone number directly
            fromNumber = rawJid.replace("@s.whatsapp.net", "");
          } else if (rawJid.endsWith("@lid")) {
            // LID — try to resolve via participant or onWhatsApp lookup
            if (msg.key.participant) {
              fromNumber = msg.key.participant.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "");
            } else {
              // Use pushName as primary identifier since LID is not a real number
              fromNumber = pushName || rawJid.replace("@lid", "");
            }
          } else if (rawJid.endsWith("@g.us")) {
            // Group message — use participant
            fromNumber = (msg.key.participant || rawJid).replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
          }

          // If we still have a LID-like number (long digits), prefer pushName
          if (fromNumber.length > 15 && pushName) {
            fromNumber = pushName;
          } else if (pushName && fromNumber !== pushName) {
            fromNumber = `${fromNumber} (${pushName})`;
          }

          await db.insert(whatsappMessages).values({
            sessionId,
            messageId: msg.key.id || `msg_${Date.now()}`,
            fromNumber,
            fromJid: rawJid,
            toNumber: sock.user?.id?.split(":")[0] || "me",
            messageType: msgType.replace("Message", ""),
            content: textContent,
            direction: "inbound",
            status: "received",
          });
        } catch (err) {
          console.error("[WhatsApp] Failed to log message:", err.message);
        }
      }
    });

    return sock;
  }

  async stopBaileysSession(sessionId) {
    const sock = this.connections.get(sessionId);
    if (sock) {
      sock.end(undefined);
      this.connections.delete(sessionId);
      this.qrCodes.delete(sessionId);
    }
    await this._updateStatus(sessionId, "disconnected");
  }

  async sendBaileysMessage(sessionId, to, text) {
    const sock = this.connections.get(sessionId);
    if (!sock) throw new Error("Session not connected");

    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });

    // Log outbound message
    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: result.key.id || `out_${Date.now()}`,
      fromNumber: sock.user?.id?.split(":")[0] || "me",
      toNumber: to.replace("@s.whatsapp.net", ""),
      messageType: "text",
      content: text,
      direction: "outbound",
      status: "sent",
    });

    return result;
  }

  // ─── whatsapp-web.js Engine ───

  async startWwebjsSession(sessionId) {
    if (this.wwejsClients.has(sessionId)) return;

    await this._updateStatus(sessionId, "connecting");

    const client = new WWJSClient({
      authStrategy: new WWJSLocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      },
    });

    this.wwejsClients.set(sessionId, client);

    client.on("qr", async (qr) => {
      const qrDataUrl = await QRCode.toDataURL(qr);
      this.qrCodes.set(sessionId, qrDataUrl);
      await this._updateStatus(sessionId, "connecting");
    });

    client.on("ready", async () => {
      this.qrCodes.delete(sessionId);
      this.connections.set(sessionId, client);
      const phoneNumber = client.info?.wid?.user || null;
      await db
        .update(whatsappSessions)
        .set({
          connectionStatus: "connected",
          phoneNumber,
          lastConnected: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(whatsappSessions.id, sessionId));
      console.log(`[WhatsApp-WWEBJS] Session ${sessionId} connected as ${phoneNumber}`);
    });

    client.on("disconnected", async (reason) => {
      this.connections.delete(sessionId);
      this.wwejsClients.delete(sessionId);
      this.qrCodes.delete(sessionId);
      await db
        .update(whatsappSessions)
        .set({ connectionStatus: "disconnected", lastError: reason, updatedAt: new Date() })
        .where(eq(whatsappSessions.id, sessionId));
      console.log(`[WhatsApp-WWEBJS] Session ${sessionId} disconnected: ${reason}`);
    });

    client.on("message", async (msg) => {
      try {
        const contact = await msg.getContact();
        const phoneNumber = contact.number || msg.from.replace("@c.us", "");
        const pushName = contact.pushname || contact.name || null;
        const fromDisplay = pushName ? `${phoneNumber} (${pushName})` : phoneNumber;

        // Download media if present
        let fileId = null;
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media?.data) {
              const ext = (media.mimetype?.split("/")[1] || "bin").split(";")[0];
              const fileName = media.filename || `${msg.type}_${Date.now()}.${ext}`;
              const buffer = Buffer.from(media.data, "base64");

              // Get orgId for this session
              const [sess] = await db.select({ organizationId: whatsappSessions.organizationId })
                .from(whatsappSessions).where(eq(whatsappSessions.id, sessionId)).limit(1);

              if (sess) {
                const fileRecord = await uploadMediaToS3(buffer, fileName, media.mimetype, sess.organizationId, sess.organizationId, sessionId);
                if (fileRecord) fileId = fileRecord.id;
              }
            }
          } catch (mediaErr) {
            console.error("[WhatsApp-WWEBJS] Media download failed:", mediaErr.message);
          }
        }

        await db.insert(whatsappMessages).values({
          sessionId,
          messageId: msg.id?.id || `wwebjs_${Date.now()}`,
          fromNumber: fromDisplay,
          fromJid: msg.from,
          toNumber: client.info?.wid?.user || "me",
          messageType: msg.type || "chat",
          content: msg.body || null,
          fileId,
          direction: "inbound",
          status: "received",
        });
      } catch (err) {
        console.error("[WhatsApp-WWEBJS] Failed to log message:", err.message);
      }
    });

    await client.initialize();
    return client;
  }

  async stopWwebjsSession(sessionId) {
    const client = this.wwejsClients.get(sessionId);
    if (client) {
      await client.destroy().catch(() => {});
      this.wwejsClients.delete(sessionId);
      this.connections.delete(sessionId);
      this.qrCodes.delete(sessionId);
    }
    await this._updateStatus(sessionId, "disconnected");
  }

  async sendWwebjsMessage(sessionId, to, text) {
    const client = this.wwejsClients.get(sessionId) || this.connections.get(sessionId);
    if (!client || typeof client.sendMessage !== "function") throw new Error("Session not connected");

    const chatId = to.includes("@") ? to : `${to}@c.us`;
    const result = await client.sendMessage(chatId, text);

    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: result.id?.id || `wwebjs_out_${Date.now()}`,
      fromNumber: client.info?.wid?.user || "me",
      toNumber: to.replace("@c.us", ""),
      messageType: "chat",
      content: text,
      direction: "outbound",
      status: "sent",
    });

    return result;
  }

  // ─── Send Media ───

  async sendMediaMessage(sessionId, to, fileUrl, fileName, mimeType, caption) {
    const [sessionRow] = await db.select({ type: whatsappSessions.type, organizationId: whatsappSessions.organizationId })
      .from(whatsappSessions).where(eq(whatsappSessions.id, sessionId)).limit(1);
    if (!sessionRow) throw new Error("Session not found");

    const msgType = mimeType?.startsWith("image") ? "image" : mimeType?.startsWith("video") ? "video" : mimeType?.startsWith("audio") ? "audio" : "document";

    // Save sent file to files table
    const fileKey = `whatsapp/${sessionRow.organizationId}/sent/${Date.now()}_${fileName}`;
    const [fileRecord] = await db.insert(files).values({
      organizationId: sessionRow.organizationId,
      uploadedBy: null,
      fileName: fileName || "file",
      fileKey,
      fileUrl,
      fileType: mimeType || null,
      folder: "whatsapp",
    }).returning();

    if (sessionRow.type === "wwebjs") {
      const client = this.wwejsClients.get(sessionId) || this.connections.get(sessionId);
      if (!client || typeof client.sendMessage !== "function") throw new Error("Session not connected");

      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString("base64");

      const { MessageMedia } = pkg;
      const media = new MessageMedia(mimeType || "application/octet-stream", base64, fileName);
      const chatId = to.includes("@") ? to : `${to}@c.us`;
      const result = await client.sendMessage(chatId, media, { caption: caption || undefined });

      await db.insert(whatsappMessages).values({
        sessionId, messageId: result.id?.id || `wwebjs_media_${Date.now()}`,
        fromNumber: client.info?.wid?.user || "me", toNumber: to.replace("@c.us", ""),
        messageType: msgType, content: caption || null, fileId: fileRecord?.id || null,
        direction: "outbound", status: "sent",
      });
      return result;

    } else if (sessionRow.type === "baileys") {
      const sock = this.connections.get(sessionId);
      if (!sock) throw new Error("Session not connected");

      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

      let msgContent;
      if (mimeType?.startsWith("image")) msgContent = { image: buffer, caption: caption || undefined, mimetype: mimeType };
      else if (mimeType?.startsWith("video")) msgContent = { video: buffer, caption: caption || undefined, mimetype: mimeType };
      else if (mimeType?.startsWith("audio")) msgContent = { audio: buffer, mimetype: mimeType };
      else msgContent = { document: buffer, fileName, mimetype: mimeType || "application/octet-stream" };

      const result = await sock.sendMessage(jid, msgContent);

      await db.insert(whatsappMessages).values({
        sessionId, messageId: result.key.id || `baileys_media_${Date.now()}`,
        fromNumber: sock.user?.id?.split(":")[0] || "me", toNumber: to.replace("@s.whatsapp.net", ""),
        messageType: msgType, content: caption || null, fileId: fileRecord?.id || null,
        direction: "outbound", status: "sent",
      });
      return result;

    } else {
      throw new Error("Media sending not supported for official API yet");
    }
  }

  // ─── Chat History (wwebjs only) ───

  async getRecentChats(sessionId, limit = 20) {
    const client = this.wwejsClients.get(sessionId);
    if (!client) throw new Error("Only available for whatsapp-web.js sessions");

    const chats = await client.getChats();
    return chats.slice(0, limit).map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage?.body?.slice(0, 100) || null,
      timestamp: chat.lastMessage?.timestamp ? new Date(chat.lastMessage.timestamp * 1000).toISOString() : null,
      phoneNumber: chat.id.user,
    }));
  }

  async getChatMessages(sessionId, contactId, limit = 50) {
    const client = this.wwejsClients.get(sessionId);
    if (!client) throw new Error("Only available for whatsapp-web.js sessions");

    const chatId = contactId.includes("@") ? contactId : `${contactId}@c.us`;
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    // Get orgId for S3 uploads
    const [sess] = await db.select({ organizationId: whatsappSessions.organizationId })
      .from(whatsappSessions).where(eq(whatsappSessions.id, sessionId)).limit(1);
    const orgId = sess?.organizationId;

    const result = [];
    for (const msg of messages) {
      let fileUrl = null;
      let fileName = null;

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media?.data && orgId) {
            const ext = (media.mimetype?.split("/")[1] || "bin").split(";")[0];
            fileName = media.filename || `${msg.type}_${msg.id.id}.${ext}`;
            const buffer = Buffer.from(media.data, "base64");
            const fileRecord = await uploadMediaToS3(buffer, fileName, media.mimetype, orgId, orgId, sessionId);
            if (fileRecord) fileUrl = fileRecord.fileUrl;
          }
        } catch { /* media download may fail for old messages */ }
      }

      result.push({
        id: msg.id.id,
        from: msg.from?.replace("@c.us", "").replace("@s.whatsapp.net", "") || "unknown",
        fromName: msg._data?.notifyName || null,
        to: msg.to?.replace("@c.us", "").replace("@s.whatsapp.net", "") || "unknown",
        body: msg.body || null,
        type: msg.type || "chat",
        timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null,
        fromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        fileUrl,
        fileName,
      });
    }
    return result;
  }

  getQR(sessionId) {
    return this.qrCodes.get(sessionId) || null;
  }

  // ─── Official API Engine ───

  async startOfficialSession(sessionId) {
    // Verify the access token works by hitting Meta's API
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);

    if (!session?.accessToken || !session?.phoneNumberId) {
      throw new Error("Access token and phone number ID are required for official API");
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${session.phoneNumberId}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || "Failed to verify access token");
      }
      await this._updateStatus(sessionId, "connected");
    } catch (err) {
      await db
        .update(whatsappSessions)
        .set({ lastError: err.message, updatedAt: new Date() })
        .where(eq(whatsappSessions.id, sessionId));
      throw err;
    }
  }

  async sendOfficialMessage(sessionId, to, text) {
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);

    if (!session) throw new Error("Session not found");

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${session.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Failed to send message");

    // Log outbound
    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: data.messages?.[0]?.id || `off_${Date.now()}`,
      fromNumber: session.phoneNumber || "business",
      toNumber: to,
      messageType: "text",
      content: text,
      direction: "outbound",
      status: "sent",
    });

    return data;
  }

  // ─── Unified Interface ───

  async startSession(sessionId) {
    const [session] = await db
      .select({ type: whatsappSessions.type })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);

    if (!session) throw new Error("Session not found");

    if (session.type === "baileys") return this.startBaileysSession(sessionId);
    if (session.type === "wwebjs") return this.startWwebjsSession(sessionId);
    if (session.type === "official") return this.startOfficialSession(sessionId);
    throw new Error(`Unknown session type: ${session.type}`);
  }

  async stopSession(sessionId) {
    const [session] = await db
      .select({ type: whatsappSessions.type })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);

    if (session?.type === "baileys") return this.stopBaileysSession(sessionId);
    if (session?.type === "wwebjs") return this.stopWwebjsSession(sessionId);
    // Official sessions are stateless — just mark disconnected
    await this._updateStatus(sessionId, "disconnected");
  }

  async sendMessage(sessionId, to, text) {
    const [session] = await db
      .select({ type: whatsappSessions.type })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);

    if (!session) throw new Error("Session not found");

    if (session.type === "baileys") return this.sendBaileysMessage(sessionId, to, text);
    if (session.type === "wwebjs") return this.sendWwebjsMessage(sessionId, to, text);
    if (session.type === "official") return this.sendOfficialMessage(sessionId, to, text);
    throw new Error(`Unknown session type: ${session.type}`);
  }

  isConnected(sessionId) {
    return this.connections.has(sessionId);
  }

  // ─── Helpers ───

  async _updateStatus(sessionId, status) {
    await db
      .update(whatsappSessions)
      .set({ connectionStatus: status, updatedAt: new Date() })
      .where(eq(whatsappSessions.id, sessionId));
  }

  /** Reconnect all Baileys sessions on server restart */
  async reconnectAll() {
    const sessions = await db
      .select({ id: whatsappSessions.id })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.type, "baileys"));

    for (const s of sessions) {
      // Only reconnect if we have creds (was previously paired)
      const [full] = await db
        .select({ creds: whatsappSessions.creds })
        .from(whatsappSessions)
        .where(eq(whatsappSessions.id, s.id))
        .limit(1);

      if (full?.creds) {
        console.log(`[WhatsApp] Auto-reconnecting session ${s.id}`);
        this.startBaileysSession(s.id).catch((err) => {
          console.error(`[WhatsApp] Failed to reconnect ${s.id}:`, err.message);
        });
      }
    }
  }
}

export const whatsappManager = new WhatsAppManager();
