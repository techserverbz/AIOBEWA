import "dotenv/config";
import { pgSchema, pgTable } from "drizzle-orm/pg-core";

/** PostgreSQL schema for app tables. Set DB_SCHEMA in .env (default: "public"). */
const schemaName = process.env.DB_SCHEMA ?? "public";
export const finalSchema =
  schemaName === "public"
    ? { table: (name, columns, extra) => pgTable(name, columns, extra) }
    : pgSchema(schemaName);
