import "dotenv/config";
import postgres from "postgres";

const SCHEMA = process.env.DB_SCHEMA ?? "public";
const prefix = SCHEMA === "public" ? "" : `"${SCHEMA}".`;

export async function ensureWhatsappSchema() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try {
    await sql.unsafe(`SET client_min_messages = WARNING`);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${prefix}whatsapp_sessions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        organization_id uuid NOT NULL REFERENCES ${prefix}organizations(id) ON DELETE CASCADE,
        type text NOT NULL,
        session_name text NOT NULL,
        phone_number text,
        scope_level text NOT NULL DEFAULT 'org',
        scope_id uuid,
        creds text,
        access_token text,
        phone_number_id text,
        waba_id text,
        webhook_verify_token text,
        connection_status text NOT NULL DEFAULT 'disconnected',
        last_connected timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(organization_id, session_name)
      )
    `);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${prefix}whatsapp_keys (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        session_id uuid NOT NULL REFERENCES ${prefix}whatsapp_sessions(id) ON DELETE CASCADE,
        key_type text NOT NULL,
        key_id text NOT NULL,
        key_data text NOT NULL,
        UNIQUE(session_id, key_type, key_id)
      )
    `);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${prefix}whatsapp_messages (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        session_id uuid NOT NULL REFERENCES ${prefix}whatsapp_sessions(id) ON DELETE CASCADE,
        message_id text NOT NULL,
        from_number text NOT NULL,
        from_jid text,
        to_number text NOT NULL,
        message_type text NOT NULL,
        content text,
        file_id uuid REFERENCES ${prefix}files(id) ON DELETE SET NULL,
        direction text NOT NULL,
        status text NOT NULL DEFAULT 'sent',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    console.log("[ensureWhatsappSchema] OK");
  } catch (err) {
    console.error("[ensureWhatsappSchema]", err.message);
    throw err;
  } finally {
    await sql.end();
  }
}
