import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { whatsappSessions } from "../schema/whatsappSessions.js";
import { whatsappKeys } from "../schema/whatsappKeys.js";
import { proto, initAuthCreds as baileysInitAuthCreds } from "@whiskeysockets/baileys";

/**
 * BufferJSON — serialize/deserialize Buffers to/from JSON-safe strings.
 * Required for Baileys auth state persistence.
 */
const BufferJSON = {
  replacer: (_key, value) => {
    if (value && value.type === "Buffer" && Array.isArray(value.data)) {
      return { __buffer: true, data: Buffer.from(value.data).toString("base64") };
    }
    return value;
  },
  reviver: (_key, value) => {
    if (value && value.__buffer) {
      return Buffer.from(value.data, "base64");
    }
    return value;
  },
  stringify: (data) => JSON.stringify(data, BufferJSON.replacer),
  parse: (str) => JSON.parse(str, BufferJSON.reviver),
};

/**
 * Create a Baileys-compatible auth state backed by PostgreSQL.
 * @param {string} sessionId - whatsapp_sessions.id
 */
export async function useDatabaseAuthState(sessionId) {
  // Load creds from whatsapp_sessions
  const [session] = await db
    .select({ creds: whatsappSessions.creds })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.id, sessionId))
    .limit(1);

  let creds = session?.creds ? BufferJSON.parse(session.creds) : baileysInitAuthCreds();

  const saveCreds = async () => {
    await db
      .update(whatsappSessions)
      .set({ creds: BufferJSON.stringify(creds), updatedAt: new Date() })
      .where(eq(whatsappSessions.id, sessionId));
  };

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        if (!ids.length) return result;

        const rows = await db
          .select({ keyId: whatsappKeys.keyId, keyData: whatsappKeys.keyData })
          .from(whatsappKeys)
          .where(
            and(
              eq(whatsappKeys.sessionId, sessionId),
              eq(whatsappKeys.keyType, type)
            )
          );

        const rowMap = new Map(rows.map((r) => [r.keyId, r.keyData]));
        for (const id of ids) {
          const data = rowMap.get(id);
          if (data) {
            let parsed = BufferJSON.parse(data);
            if (type === "app-state-sync-key" && parsed) {
              parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
            }
            result[id] = parsed;
          }
        }
        return result;
      },

      set: async (data) => {
        const inserts = [];
        const deletes = [];

        for (const [type, keys] of Object.entries(data)) {
          for (const [id, value] of Object.entries(keys)) {
            if (value) {
              inserts.push({ sessionId, keyType: type, keyId: id, keyData: BufferJSON.stringify(value) });
            } else {
              deletes.push({ type, id });
            }
          }
        }

        // Upsert keys
        for (const row of inserts) {
          const [existing] = await db
            .select({ id: whatsappKeys.id })
            .from(whatsappKeys)
            .where(
              and(
                eq(whatsappKeys.sessionId, row.sessionId),
                eq(whatsappKeys.keyType, row.keyType),
                eq(whatsappKeys.keyId, row.keyId)
              )
            )
            .limit(1);

          if (existing) {
            await db
              .update(whatsappKeys)
              .set({ keyData: row.keyData })
              .where(eq(whatsappKeys.id, existing.id));
          } else {
            await db.insert(whatsappKeys).values(row);
          }
        }

        // Delete nulled keys
        for (const { type, id } of deletes) {
          await db
            .delete(whatsappKeys)
            .where(
              and(
                eq(whatsappKeys.sessionId, sessionId),
                eq(whatsappKeys.keyType, type),
                eq(whatsappKeys.keyId, id)
              )
            );
        }
      },
    },
  };

  return { state, saveCreds };
}

export { BufferJSON };
