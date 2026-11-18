import crypto from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM for the Gmail refresh token at rest, so a leaked DB doesn't expose
// a usable credential. GCM's auth tag also lets us detect tampering on decrypt.
// Stored as <iv_hex>:<authTag_hex>:<ciphertext_hex>.

const KEY = Buffer.from(config.tokenEncKey, "hex");
if (KEY.length !== 32) {
  throw new Error(
    "TOKEN_ENC_KEY must be 32 bytes hex (64 chars). Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed encrypted token");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    KEY,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
