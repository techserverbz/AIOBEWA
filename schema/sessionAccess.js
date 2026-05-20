import { uuid, timestamp, unique } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { pkv7 } from "../lib/uuid.js";
import { users } from "./users.js";
import { whatsappSessions } from "./whatsappSessions.js";

// Which users may view which WhatsApp business accounts (sessions).
// Admin manages these grants; a user with a row here can view that session.
export const sessionAccess = finalSchema.table(
  "session_access",
  {
    id: pkv7(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => whatsappSessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: unique().on(t.userId, t.sessionId) }),
);
