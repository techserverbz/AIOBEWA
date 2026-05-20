import { eq } from "drizzle-orm";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia, Message } = pkg;
import QRCode from "qrcode";
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappMessages } from "../schema/whatsappMessages.js";
import { files } from "../schema/files.js";

const S3_SIGNED_URL_ENDPOINT = "https://wkgijoo8il.execute-api.ap-south-1.amazonaws.com/prod/gsu";
const S3_BUCKET = "server-sided-s3";
const S3_REGION = "ap-south-1";

// ─── S3 Helper ─────────────────────────────────────────────────

async function uploadToS3(buffer, fileName, mimeType, orgId, sessionId) {
  const d = new Date();
  const key = `whatsapp/${orgId}/media/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${sessionId}/${Date.now()}_${fileName}`;

  const signedRes = await fetch(S3_SIGNED_URL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket: S3_BUCKET, account: "SHUBHAM", key1: key, Expires: 300 }),
  });
  const { signedUrl } = await signedRes.json();

  await fetch(signedUrl, {
    method: "PUT",
    body: buffer,
    headers: { "Content-Type": mimeType || "application/octet-stream" },
  });

  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const fileUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodedKey}`;

  const [record] = await db.insert(files).values({
    organizationId: orgId,
    uploadedBy: null,
    fileName,
    fileKey: key,
    fileUrl,
    fileType: mimeType || null,
    fileSize: buffer.length || null,
    folder: "whatsapp",
  }).returning();

  return record;
}

// ─── WhatsApp Manager ──────────────────────────────────────────

class WhatsAppManager {
  constructor() {
    /** @type {Map<string, import('whatsapp-web.js').Client>} */
    this.clients = new Map();
    /** @type {Map<string, string>} sessionId → QR data URL */
    this.qrCodes = new Map();
    /** @type {Map<string, { chats: Array, timestamp: number }>} sessionId → cached chats */
    this.chatCache = new Map();
    this.CHAT_CACHE_TTL = 15_000; // 15 seconds
    /** @type {Set<string>} `${sessionId}:${chatId}` we've already asked the phone to backfill */
    this.historyRequested = new Set();
    /** @type {Map<string, {data: Buffer, mimetype: string, filename: string}>} downloaded media, LRU */
    this.mediaCache = new Map();
    this.mediaCacheBytes = 0;
    this.MEDIA_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
  }

  // ─── Start Session ───

  async startSession(sessionId) {
    if (this.clients.has(sessionId)) return;
    await this._setStatus(sessionId, "connecting");

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
        ],
      },
    });

    this.clients.set(sessionId, client);

    client.on("qr", async (qr) => {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        this.qrCodes.set(sessionId, dataUrl);
        await this._setStatus(sessionId, "connecting");
        console.log(`[WA] QR generated for session ${sessionId}`);
      } catch (e) {
        console.error(`[WA] QR generation failed:`, e.message);
      }
    });

    client.on("ready", async () => {
      this.qrCodes.delete(sessionId);
      const phone = client.info?.wid?.user || null;
      await db.update(whatsappSessions).set({
        connectionStatus: "connected",
        phoneNumber: phone,
        lastConnected: new Date(),
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(whatsappSessions.id, sessionId));
      console.log(`[WA] Session ${sessionId} connected as ${phone}`);
    });

    client.on("disconnected", async (reason) => {
      this.clients.delete(sessionId);
      this.qrCodes.delete(sessionId);
      this.chatCache.delete(sessionId);
      await db.update(whatsappSessions).set({
        connectionStatus: "disconnected",
        lastError: reason || "Disconnected",
        updatedAt: new Date(),
      }).where(eq(whatsappSessions.id, sessionId));
      console.log(`[WA] Session ${sessionId} disconnected: ${reason}`);
    });

    client.on("auth_failure", async (msg) => {
      this.clients.delete(sessionId);
      this.qrCodes.delete(sessionId);
      await db.update(whatsappSessions).set({
        connectionStatus: "disconnected",
        lastError: `Auth failed: ${msg}`,
        updatedAt: new Date(),
      }).where(eq(whatsappSessions.id, sessionId));
      console.error(`[WA] Auth failure for ${sessionId}: ${msg}`);
    });

    // ─── Incoming Messages (log only, NO S3 upload) ───
    client.on("message", async (msg) => {
      try {
        const contact = await msg.getContact();
        const phone = contact.number || msg.from.replace("@c.us", "").replace("@g.us", "");
        const pushName = contact.pushname || contact.name || null;
        const display = pushName ? `${phone} (${pushName})` : phone;

        await db.insert(whatsappMessages).values({
          sessionId,
          messageId: msg.id?.id || `in_${Date.now()}`,
          fromNumber: display,
          fromJid: msg.from,
          toNumber: client.info?.wid?.user || "me",
          messageType: msg.type || "chat",
          content: msg.body || null,
          fileId: null, // No auto S3 upload — user saves explicitly
          direction: "inbound",
          status: "received",
        });
      } catch (err) {
        console.error("[WA] Failed to log incoming message:", err.message);
      }
    });

    try {
      await client.initialize();
    } catch (err) {
      this.clients.delete(sessionId);
      this.qrCodes.delete(sessionId);
      await db.update(whatsappSessions).set({
        connectionStatus: "disconnected",
        lastError: err.message,
        updatedAt: new Date(),
      }).where(eq(whatsappSessions.id, sessionId));
      throw err;
    }
  }

  // ─── Stop Session ───

  async stopSession(sessionId) {
    const client = this.clients.get(sessionId);
    if (client) {
      try { await client.destroy(); } catch {}
      this.clients.delete(sessionId);
      this.qrCodes.delete(sessionId);
    }
    this.chatCache.delete(sessionId);
    await this._setStatus(sessionId, "disconnected");
  }

  // ─── Auto-reconnect sessions that were previously connected ───

  async autoReconnect() {
    try {
      const sessions = await db.select({
        id: whatsappSessions.id,
        type: whatsappSessions.type,
        sessionName: whatsappSessions.sessionName,
      })
        .from(whatsappSessions)
        .where(eq(whatsappSessions.connectionStatus, "connected"));

      if (sessions.length === 0) {
        console.log("[WA] No sessions to auto-reconnect");
        return;
      }

      console.log(`[WA] Auto-reconnecting ${sessions.length} session(s)...`);
      for (const session of sessions) {
        if (session.type !== "wwebjs") continue;
        try {
          console.log(`[WA] Reconnecting "${session.sessionName}" (${session.id})...`);
          await this.startSession(session.id);
        } catch (err) {
          console.error(`[WA] Failed to reconnect "${session.sessionName}": ${err.message}`);
        }
      }
    } catch (err) {
      console.error("[WA] Auto-reconnect error:", err.message);
    }
  }

  // ─── Resolve a chatId to a sendable format ───
  // WhatsApp Web now uses LID internally. When a contact's chat ID is
  // `<lid_number>@lid`, we need to find the real phone number to send.
  // If the number is already a phone, we use `@c.us`.

  async _resolveSendableId(client, to) {
    // If it already contains @c.us or @g.us, use as-is
    if (to.includes("@c.us") || to.includes("@g.us")) return to;
    // If it contains @lid, resolve to phone number via Puppeteer
    if (to.includes("@lid")) {
      const phone = await this._lidToPhone(client, to);
      if (phone) return `${phone}@c.us`;
      throw new Error(`Could not resolve LID ${to} to a phone number`);
    }
    // Raw number — check if it looks like a real phone number (<=15 digits)
    const digits = to.replace(/\D/g, "");
    if (digits.length <= 15) {
      return `${digits}@c.us`;
    }
    // It's probably a LID number without the @lid suffix
    const phone = await this._lidToPhone(client, `${digits}@lid`);
    if (phone) return `${phone}@c.us`;
    // Last resort: try sending as-is
    return `${digits}@c.us`;
  }

  // Resolve LID → phone number via WhatsApp Web's internal store
  async _lidToPhone(client, lidJid) {
    try {
      const phone = await client.pupPage.evaluate(async (lid) => {
        try {
          const wid = window.Store.WidFactory.createWid(lid);
          // Try LidUtils first
          if (window.Store.LidUtils?.getPhoneNumber) {
            const pn = window.Store.LidUtils.getPhoneNumber(wid);
            if (pn?.user) return pn.user;
          }
          // Try QueryExist to force resolution
          const result = await window.Store.QueryExist(wid);
          if (result?.wid?.user) return result.wid.user;
          return null;
        } catch {
          return null;
        }
      }, lidJid);
      return phone;
    } catch {
      return null;
    }
  }

  // ─── Send Text ───

  async sendText(sessionId, to, text) {
    const client = this._getClient(sessionId);

    // Strategy: try sending directly with the given ID first.
    // If it's a @lid chat ID, wwebjs sendMessage internally handles it
    // via the patched Utils.js. If that fails, resolve LID→phone and retry.
    let chatId = to.includes("@") ? to : `${to}@c.us`;
    console.log(`[WA] Sending text to ${chatId}`);

    let result;
    try {
      result = await client.sendMessage(chatId, text);
    } catch (err) {
      console.warn(`[WA] Send failed (${err.message}), trying LID resolution...`);
      const resolved = await this._resolveSendableId(client, to);
      if (resolved !== chatId) {
        console.log(`[WA] Resolved to ${resolved}, retrying...`);
        result = await client.sendMessage(resolved, text);
      } else {
        throw err;
      }
    }

    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: result.id?.id || `out_${Date.now()}`,
      fromNumber: client.info?.wid?.user || "me",
      fromJid: null,
      toNumber: to.replace(/@c\.us$/, "").replace(/@lid$/, ""),
      messageType: "chat",
      content: text,
      direction: "outbound",
      status: "sent",
    });

    return result;
  }

  // ─── Send Media ───

  async sendMedia(sessionId, to, fileUrl, fileName, mimeType, caption) {
    const client = this._getClient(sessionId);

    let chatId = to.includes("@") ? to : `${to}@c.us`;
    console.log(`[WA] Sending media to ${chatId}`);

    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");

    const media = new MessageMedia(
      mimeType || "application/octet-stream",
      base64,
      fileName || "file"
    );

    let result;
    try {
      result = await client.sendMessage(chatId, media, { caption: caption || undefined });
    } catch (err) {
      console.warn(`[WA] Media send failed (${err.message}), trying LID resolution...`);
      const resolved = await this._resolveSendableId(client, to);
      if (resolved !== chatId) {
        result = await client.sendMessage(resolved, media, { caption: caption || undefined });
      } else {
        throw err;
      }
    }

    const [sess] = await db.select({ organizationId: whatsappSessions.organizationId })
      .from(whatsappSessions).where(eq(whatsappSessions.id, sessionId)).limit(1);

    let fileId = null;
    if (sess) {
      const record = await uploadToS3(buffer, fileName || "file", mimeType, sess.organizationId, sessionId);
      if (record) fileId = record.id;
    }

    const msgType = mimeType?.startsWith("image") ? "image"
      : mimeType?.startsWith("video") ? "video"
      : mimeType?.startsWith("audio") ? "audio"
      : "document";

    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: result.id?.id || `out_media_${Date.now()}`,
      fromNumber: client.info?.wid?.user || "me",
      fromJid: null,
      toNumber: to.replace(/@c\.us$/, "").replace(/@lid$/, ""),
      messageType: msgType,
      content: caption || null,
      fileId,
      direction: "outbound",
      status: "sent",
    });

    return result;
  }

  // ─── Send Media from buffer (no S3 needed) ───

  async sendMediaBuffer(sessionId, to, buffer, fileName, mimeType, caption, opts = {}) {
    const client = this._getClient(sessionId);

    let chatId = to.includes("@") ? to : `${to}@c.us`;
    console.log(`[WA] Sending media buffer to ${chatId} (${mimeType}, ${buffer.length}B)`);

    const base64 = buffer.toString("base64");
    const media = new MessageMedia(mimeType || "application/octet-stream", base64, fileName || "file");

    const sendOpts = {
      caption: caption || undefined,
      sendAudioAsVoice: opts.sendType === "ptt",
    };

    let result;
    try {
      result = await client.sendMessage(chatId, media, sendOpts);
    } catch (err) {
      console.warn(`[WA] Media send failed (${err.message}), trying LID resolution...`);
      const resolved = await this._resolveSendableId(client, to);
      if (resolved !== chatId) {
        result = await client.sendMessage(resolved, media, sendOpts);
      } else {
        throw err;
      }
    }

    const msgType = mimeType?.startsWith("image") ? "image"
      : mimeType?.startsWith("video") ? "video"
      : (mimeType?.startsWith("audio") && opts.sendType === "ptt") ? "ptt"
      : mimeType?.startsWith("audio") ? "audio"
      : "document";

    await db.insert(whatsappMessages).values({
      sessionId,
      messageId: result.id?.id || `out_media_${Date.now()}`,
      fromNumber: client.info?.wid?.user || "me",
      fromJid: null,
      toNumber: to.replace(/@c\.us$/, "").replace(/@lid$/, ""),
      messageType: msgType,
      content: caption || null,
      direction: "outbound",
      status: "sent",
    });

    return result;
  }

  invalidateChatCache(sessionId) {
    this.chatCache.delete(sessionId);
  }

  // ─── Get Recent Chats (cached + parallel LID resolution) ───

  async getChats(sessionId, limit = 20) {
    const client = this._getClient(sessionId);

    // Return cached chats if still fresh
    const cached = this.chatCache.get(sessionId);
    if (cached && (Date.now() - cached.timestamp) < this.CHAT_CACHE_TTL) {
      return cached.chats.slice(0, limit);
    }

    const chats = await client.getChats();
    const sliced = chats.slice(0, limit);

    // Resolve all chats in parallel instead of sequentially
    const results = await Promise.all(sliced.map(async (chat) => {
      const serialized = chat.id._serialized;
      const isLid = serialized.endsWith("@lid");
      let phoneNumber = chat.id.user;
      let name = chat.name || chat.id.user;

      if (isLid) {
        try {
          // Resolve LID and contact in parallel
          const [resolved, contact] = await Promise.all([
            this._lidToPhone(client, serialized),
            client.getContactById(serialized).catch(() => null),
          ]);
          if (resolved) phoneNumber = resolved;
          if (contact) {
            name = contact.pushname || contact.name || contact.number || name;
            if (contact.number) phoneNumber = contact.number;
          }
        } catch {}
      }

      return {
        id: serialized,
        name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessage: chat.lastMessage?.body?.slice(0, 100) || null,
        timestamp: chat.lastMessage?.timestamp
          ? new Date(chat.lastMessage.timestamp * 1000).toISOString()
          : null,
        phoneNumber,
      };
    }));

    // Cache the results
    this.chatCache.set(sessionId, { chats: results, timestamp: Date.now() });
    return results;
  }

  // ─── Request older history from the phone (on-demand history sync) ───
  // WhatsApp only pushes recent messages to a freshly-linked web client; older
  // history must be pulled from the phone via a peer-data-operation request.
  // wwebjs exposes this as client.syncHistory(chatId). Returns true if a sync
  // was actually requested (i.e. there's more history to pull).
  async syncHistory(sessionId, chatId) {
    const client = this._getClient(sessionId);
    try {
      return await client.syncHistory(chatId);
    } catch (err) {
      console.warn(`[WA] syncHistory failed: ${err.message?.slice(0, 80)}`);
      return false;
    }
  }

  // ─── Get Chat Messages (NO S3 upload — just metadata) ───

  async getChatMessages(sessionId, contactId, limit = 50) {
    const client = this._getClient(sessionId);

    let chatId = contactId;
    if (!contactId.includes("@")) {
      chatId = `${contactId}@c.us`;
    }

    let chat;
    try {
      chat = await client.getChatById(chatId);
    } catch {
      if (!chatId.includes("@lid")) {
        try { chat = await client.getChatById(`${contactId}@lid`); } catch {}
      }
    }
    if (!chat) throw new Error("Chat not found");

    // Viewing a chat marks it read (clears the unread badge here and on the
    // phone), matching WhatsApp Web behaviour. Fire-and-forget.
    if (chat.unreadCount > 0) chat.sendSeen().catch(() => {});

    // Read the full synced history straight from the browser's IndexedDB
    // (model-storage > message). wwebjs's fetchMessages -> loadEarlierMsgs is
    // broken on this WA Web build (crashes on undefined.waitForChatLoading), and
    // IndexedDB holds everything the device has synced — so go there directly
    // instead of paying for a doomed fetchMessages round-trip on every call.
    let msgs;
    {
      const raw = await client.pupPage.evaluate(async (ser, lim) => {
        const openDb = (name) => new Promise((res) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(null);
        });
        const idb = await openDb("model-storage");
        if (!idb) return { error: "no-idb", msgs: [] };

        // Message primary keys look like `{fromMe}_{remote}_{hash}[_{author}]`.
        // Scan the two key-ranges for this chat (incoming + outgoing) — far cheaper
        // than iterating all ~20k messages.
        const collectRange = (os, prefix) => new Promise((res) => {
          const out = [];
          const range = IDBKeyRange.bound(prefix, prefix + "￿");
          const cur = os.openCursor(range);
          cur.onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return res(out);
            const key = typeof c.key === "string" ? c.key : c.value?.id;
            // Guard against author-suffixed group keys leaking from a sibling range.
            if (typeof key === "string" && key.split("_")[1] === ser) {
              out.push({ key, t: c.value?.t || 0, notify: c.value?.isNotification });
            }
            c.continue();
          };
          cur.onerror = () => res(out);
        });

        const tx = idb.transaction("message", "readonly");
        const os = tx.objectStore("message");
        const [inc, out] = await Promise.all([
          collectRange(os, `false_${ser}_`),
          collectRange(os, `true_${ser}_`),
        ]);
        idb.close();

        let rows = [...inc, ...out].filter((r) => !r.notify);
        rows.sort((a, b) => a.t - b.t);
        rows = rows.slice(-lim); // newest `lim`
        const ids = rows.map((r) => r.key);

        // Hydrate proper Message models (gives body/media/ack) in batches.
        const models = [];
        for (let i = 0; i < ids.length; i += 300) {
          const batch = ids.slice(i, i + 300);
          try {
            const r = await window.Store.Msg.getMessagesById(batch);
            for (const m of (r?.messages || [])) {
              if (!m.isNotification) models.push(window.WWebJS.getMessageModel(m));
            }
          } catch {}
        }
        models.sort((a, b) => (a.t || 0) - (b.t || 0));
        return { msgs: models, found: ids.length };
      }, chat.id._serialized, limit);
      const { Message } = pkg;
      msgs = (raw?.msgs || []).map((d) => new Message(client, d));
      if (raw?.error) console.warn(`[WA] history read: ${raw.error}`);
    }

    // If the web client's local buffer is short of what was asked, ask the phone
    // to backfill older history (once per chat). The messages stream in
    // asynchronously and the FE's periodic refresh will pick them up.
    if (msgs.length < limit) {
      const key = `${sessionId}:${chat.id._serialized}`;
      if (!this.historyRequested.has(key)) {
        this.historyRequested.add(key);
        client.syncHistory(chat.id._serialized).catch(() => {});
      }
    }

    const results = [];
    for (const msg of msgs) {
      let fromDisplay = msg.from?.replace(/@c\.us$/, "").replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "") || "unknown";

      // Use the full serialized message ID so the media endpoint can find it
      const serializedId = msg.id._serialized || `${msg.fromMe ? "true" : "false"}_${msg.from}_${msg.id.id}`;

      results.push({
        id: serializedId,
        from: fromDisplay,
        fromName: msg._data?.notifyName || null,
        to: msg.to?.replace(/@c\.us$/, "").replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "") || "unknown",
        body: msg.body || null,
        type: msg.type || "chat",
        timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null,
        fromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        fileUrl: null,
        fileName: msg._data?.filename || null,
        // Dimensions let the UI reserve the exact aspect ratio so media loading
        // in never shifts the layout (smooth scrolling).
        width: msg._data?.width || null,
        height: msg._data?.height || null,
      });
    }

    return results;
  }

  // ─── Stream media on-demand (for preview, NO S3) ───

  async getMedia(sessionId, messageId) {
    // Serve from the in-memory cache so each media item is only downloaded +
    // decrypted once — repeat views (re-scroll, re-render, reload) are instant.
    const cacheKey = `${sessionId}:${messageId}`;
    const cached = this.mediaCache.get(cacheKey);
    if (cached) {
      // refresh LRU recency
      this.mediaCache.delete(cacheKey);
      this.mediaCache.set(cacheKey, cached);
      return cached;
    }

    const client = this._getClient(sessionId);

    // messageId is the full serialized ID like "true_919xxx@c.us_3EB0ABC123"
    // or "false_919xxx@lid_3EB0ABC123"
    const msg = await client.pupPage.evaluate(async (msgId) => {
      // Try direct lookup by serialized ID first
      let m = window.Store.Msg.get(msgId);
      if (!m) {
        // Try getMessagesById which fetches from server if needed
        try {
          const result = await window.Store.Msg.getMessagesById([msgId]);
          m = result?.messages?.[0];
        } catch {}
      }
      if (!m) {
        // Try with MsgKey
        try {
          const key = window.Store.MsgKey.fromString(msgId);
          m = window.Store.Msg.get(key);
          if (!m) {
            const result = await window.Store.Msg.getMessagesById([key._serialized || key.toString()]);
            m = result?.messages?.[0];
          }
        } catch {}
      }
      if (!m) return null;
      return window.WWebJS.getMessageModel(m);
    }, messageId);

    if (!msg) throw new Error("Message not found — it may have expired from WhatsApp's cache");

    const waMsg = new Message(client, msg);
    if (!waMsg.hasMedia) throw new Error("Message has no media");

    const media = await waMsg.downloadMedia();
    if (!media?.data) throw new Error("Media download failed");

    const out = {
      data: Buffer.from(media.data, "base64"),
      mimetype: media.mimetype || "application/octet-stream",
      filename: media.filename || `media_${messageId.split("_").pop() || Date.now()}`,
    };

    // Cache it (LRU, capped by total bytes) so the next view is instant.
    this.mediaCache.set(cacheKey, out);
    this.mediaCacheBytes += out.data.length;
    while (this.mediaCacheBytes > this.MEDIA_CACHE_MAX_BYTES && this.mediaCache.size > 1) {
      const oldestKey = this.mediaCache.keys().next().value;
      const evicted = this.mediaCache.get(oldestKey);
      this.mediaCache.delete(oldestKey);
      if (evicted) this.mediaCacheBytes -= evicted.data.length;
    }
    return out;
  }

  // ─── Save media to S3 (explicit user action, with title/description) ───

  async saveMediaToS3(sessionId, messageId, { title, description } = {}) {
    const media = await this.getMedia(sessionId, messageId);

    const [sess] = await db.select({ organizationId: whatsappSessions.organizationId })
      .from(whatsappSessions).where(eq(whatsappSessions.id, sessionId)).limit(1);
    if (!sess) throw new Error("Session not found");

    const ext = (media.mimetype?.split("/")[1] || "bin").split(";")[0];
    const fileName = media.filename?.includes(".") ? media.filename : `${media.filename}.${ext}`;

    const record = await uploadToS3(media.data, fileName, media.mimetype, sess.organizationId, sessionId);
    if (!record) throw new Error("S3 upload failed");

    // Update file record with title, description, and source
    const updates = { folder: "whatsapp", source: "whatsapp" };
    if (title) updates.title = title;
    if (description) updates.description = description;
    await db.update(files).set(updates).where(eq(files.id, record.id));

    return { fileId: record.id, fileUrl: record.fileUrl, fileName, title: title || null, description: description || null };
  }

  // ─── QR / Status ───

  getQR(sessionId) {
    return this.qrCodes.get(sessionId) || null;
  }

  isConnected(sessionId) {
    return this.clients.has(sessionId);
  }

  // ─── Helpers ───

  _getClient(sessionId) {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Session not connected");
    return client;
  }

  async _setStatus(sessionId, status) {
    await db.update(whatsappSessions).set({
      connectionStatus: status,
      updatedAt: new Date(),
    }).where(eq(whatsappSessions.id, sessionId));
  }

}

export const whatsappManager = new WhatsAppManager();
