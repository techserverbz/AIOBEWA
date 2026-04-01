import { pgTable, uuid, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import { pkv7 } from "../lib/uuid.js";

export const files = finalSchema.table("files", {
  id: pkv7(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  uploadedBy: uuid("uploaded_by")
    .references(() => users.id, { onDelete: "set null" }),
  fileName: text("file_name").notNull(),
  title: text("title"), // user-friendly display title
  description: text("description"), // user-provided description
  fileKey: text("file_key").notNull(), // S3 key path
  fileUrl: text("file_url").notNull(), // public/signed URL
  fileType: text("file_type"), // mime type e.g. image/jpeg, application/pdf
  fileSize: integer("file_size"), // bytes
  folder: text("folder").default("general"), // logical grouping
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
