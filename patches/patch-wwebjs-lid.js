/**
 * Patch whatsapp-web.js to fix "No LID for user" error.
 *
 * The issue: WhatsApp Web now uses LID (Linked ID) addressing internally.
 * When getMaybeMeLidUser() returns null, the sendMessage function crashes.
 * This patch adds fallback logic so it uses whichever identity is available.
 *
 * Run after npm install: node patches/patch-wwebjs-lid.js
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(__dirname, "../node_modules/whatsapp-web.js/src/util/Injected/Utils.js");

let code = readFileSync(utilsPath, "utf-8");

// Patch 1: Fix "from" assignment for direct chats
code = code.replace(
  `let from = chat.id.isLid() ? lidUser : meUser;`,
  `let from = chat.id.isLid() ? (lidUser || meUser) : (meUser || lidUser);`
);

// Patch 2: Fix "from" assignment for groups
code = code.replace(
  `from = chat.groupMetadata && chat.groupMetadata.isLidAddressingMode ? lidUser : meUser;`,
  `from = chat.groupMetadata && chat.groupMetadata.isLidAddressingMode ? (lidUser || meUser) : (meUser || lidUser);`
);

// Patch 3: Guard asUserWidOrThrow calls (group participant)
code = code.replace(
  /participant = window\.Store\.WidFactory\.asUserWidOrThrow\(from\);/g,
  `participant = from ? window.Store.WidFactory.asUserWidOrThrow(from) : undefined;`
);

writeFileSync(utilsPath, code, "utf-8");
console.log("[patch] whatsapp-web.js LID fallback applied successfully.");
