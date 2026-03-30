import { pgTable, uuid, text, uniqueIndex } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { whatsappSessions } from "./whatsappSessions.js";
import { pkv7 } from "../lib/uuid.js";

export const whatsappKeys = finalSchema.table(
  "whatsapp_keys",
  {
    id: pkv7(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => whatsappSessions.id, { onDelete: "cascade" }),
    keyType: text("key_type").notNull(), // pre-key, session, sender-key, app-state-sync-key, etc.
    keyId: text("key_id").notNull(),
    keyData: text("key_data").notNull(), // BufferJSON serialized
  },
  (t) => [uniqueIndex("wa_keys_session_type_id").on(t.sessionId, t.keyType, t.keyId)]
);
