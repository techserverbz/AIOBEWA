import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { users } from "./users.js";
import { pkv7 } from "../lib/uuid.js";

export const organizations = finalSchema.table("organizations", {
  id: pkv7(),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  isDisabled: boolean("is_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
