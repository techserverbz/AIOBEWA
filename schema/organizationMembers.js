import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import { pkv7 } from "../lib/uuid.js";

export const organizationMembers = finalSchema.table(
  "organization_members",
  {
    id: pkv7(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'admin' | 'member'
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("org_member_org_user").on(t.organizationId, t.userId)]
);
