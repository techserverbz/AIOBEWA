import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { pkv7 } from "../lib/uuid.js";

export const users = finalSchema.table("users", {
  id: pkv7(),
  username: text("username").notNull().unique(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  passwordHash: text("password_hash").notNull(),
  isDisabled: boolean("is_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
