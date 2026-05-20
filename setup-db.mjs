import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

try {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
    DECLARE
      unix_ts_ms bytea;
      uuid_bytes bytea;
    BEGIN
      unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
      uuid_bytes := unix_ts_ms || gen_random_bytes(10);
      uuid_bytes := set_byte(uuid_bytes, 6, ((get_byte(uuid_bytes, 6) & 15) | 112));
      uuid_bytes := set_byte(uuid_bytes, 8, ((get_byte(uuid_bytes, 8) & 63) | 128));
      RETURN encode(uuid_bytes, 'hex')::uuid;
    END
    $$ LANGUAGE plpgsql VOLATILE;
  `);
  console.log("[setup] uuidv7() OK");

  await sql.unsafe(`DROP TABLE IF EXISTS whatsapp_messages CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS whatsapp_keys CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS whatsapp_sessions CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS organization_members CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS files CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS organizations CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS users CASCADE`);
  console.log("[setup] dropped old tables");

  await sql.unsafe(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      username text NOT NULL UNIQUE,
      full_name text NOT NULL,
      email text NOT NULL UNIQUE,
      password text NOT NULL,
      password_hash text NOT NULL,
      is_disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log("[setup] users OK");

  await sql.unsafe(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      name text NOT NULL,
      join_code text NOT NULL UNIQUE,
      created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log("[setup] organizations OK");

  await sql.unsafe(`
    CREATE TABLE organization_members (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL,
      joined_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS org_member_org_user ON organization_members(organization_id, user_id)`);
  console.log("[setup] organization_members OK");

  await sql.unsafe(`
    CREATE TABLE files (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      filename text,
      mime_type text,
      storage_url text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log("[setup] files OK");

  await sql.unsafe(`
    INSERT INTO users (username, full_name, email, password, password_hash)
    VALUES ('dev', 'Dev User', 'dev@localhost', 'unused', 'unused')
    ON CONFLICT (email) DO NOTHING
  `);
  const [u] = await sql.unsafe(`SELECT id FROM users WHERE email = 'dev@localhost'`);
  await sql.unsafe(
    `INSERT INTO organizations (name, join_code, created_by) VALUES ('Dev Org', 'DEVORG', $1) ON CONFLICT (join_code) DO NOTHING`,
    [u.id]
  );
  const [o] = await sql.unsafe(`SELECT id FROM organizations WHERE join_code = 'DEVORG'`);
  await sql.unsafe(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
    [o.id, u.id]
  );
  console.log("[setup] seeded dev user/org/membership", { user: u.id, org: o.id });

  console.log("[setup] DONE");
} catch (e) {
  console.error("[setup] FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
