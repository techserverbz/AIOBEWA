import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { whatsappSessions } from "./whatsappSessions.js";
import { files } from "./files.js";
import { pkv7 } from "../lib/uuid.js";

export const whatsappMessages = finalSchema.table("whatsapp_messages", {
  id: pkv7(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => whatsappSessions.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(), // WhatsApp message ID
  fromNumber: text("from_number").notNull(),
  fromJid: text("from_jid"), // raw WhatsApp JID (for replying — includes @lid, @s.whatsapp.net)
  toNumber: text("to_number").notNull(),
  messageType: text("message_type").notNull(), // text, image, video, document, audio
  content: text("content"), // text body (null for media-only)
  fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }), // FK to files table for media
  direction: text("direction").notNull(), // inbound, outbound
  status: text("status").notNull().default("sent"), // sent, delivered, read, failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
