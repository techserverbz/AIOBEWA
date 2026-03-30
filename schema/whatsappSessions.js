import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { organizations } from "./organizations.js";
import { pkv7 } from "../lib/uuid.js";

export const whatsappSessions = finalSchema.table(
  "whatsapp_sessions",
  {
    id: pkv7(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "baileys" | "official"
    sessionName: text("session_name").notNull(),
    phoneNumber: text("phone_number"),

    // Scope — which hierarchy level this session belongs to
    scopeLevel: text("scope_level").notNull().default("org"), // org | company | branch | department | team
    scopeId: uuid("scope_id"), // null = org-level, otherwise FK to the entity

    // Baileys-specific (null for official)
    creds: text("creds"), // BufferJSON serialized auth credentials

    // Official API-specific (null for baileys)
    accessToken: text("access_token"),
    phoneNumberId: text("phone_number_id"),
    wabaId: text("waba_id"),
    webhookVerifyToken: text("webhook_verify_token"),

    // Shared
    connectionStatus: text("connection_status").notNull().default("disconnected"), // disconnected | connecting | connected
    lastConnected: timestamp("last_connected", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wa_sessions_org_name").on(t.organizationId, t.sessionName)]
);
