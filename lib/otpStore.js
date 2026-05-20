/**
 * OTP store: in-memory with file persistence so OTPs survive server restarts.
 * Key = email:purpose (signup / forgot-password / forgot-username).
 * OTPs expire after OTP_EXPIRY_MINUTES and are single-use (cleared on verify).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OTP_EXPIRY_MINUTES = 10;
const store = new Map();

/** Always under backend root so path is correct regardless of process.cwd(). */
const PERSIST_PATH = path.join(__dirname, "..", ".otp-store.json");

function key(email, purpose) {
  return `${String(email).toLowerCase().trim()}:${purpose}`;
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function loadFromFile() {
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.expiresAt === "number" && v.expiresAt > now) {
          store.set(k, { code: v.code, expiresAt: v.expiresAt });
        }
      }
    }
  } catch (_) {
    // ignore read errors
  }
}

function saveToFile() {
  try {
    const obj = Object.fromEntries(store.entries());
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj), "utf8");
  } catch (_) {
    // ignore write errors
  }
}

function purgeExpired() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of store.entries()) {
    if (v.expiresAt <= now) {
      store.delete(k);
      changed = true;
    }
  }
  if (changed) saveToFile();
}

export function setOtp(email, purpose) {
  purgeExpired();
  loadFromFile();
  const code = randomCode();
  const expiresAt = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;
  store.set(key(email, purpose), { code, expiresAt });
  saveToFile();
  return { code, expiresAt };
}

/** Normalize user input to 6 digits only (handles spaces, dashes, or string/number from frontend). */
function normalizeCode(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits.length === 6 ? digits : String(input ?? "").trim();
}

export function consumeOtp(email, purpose, code) {
  const k = key(email, purpose);
  let entry = store.get(k);
  if (!entry) {
    loadFromFile();
    entry = store.get(k);
  }
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    store.delete(k);
    saveToFile();
    return false;
  }
  const normalized = normalizeCode(code);
  if (entry.code !== normalized) return false;
  store.delete(k);
  saveToFile();
  return true;
}

export function getOtpExpiryMinutes() {
  return OTP_EXPIRY_MINUTES;
}
