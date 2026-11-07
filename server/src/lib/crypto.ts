import crypto from "node:crypto";
import { env } from "../config.js";

function key() {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY not configured");
  return crypto.createHash("sha256").update(env.ENCRYPTION_KEY).digest();
}

export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string) {
  const [iv, tag, enc] = payload.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
}

export function sign(value: string) {
  const mac = crypto.createHmac("sha256", key()).update(value).digest("base64url");
  return `${value}.${mac}`;
}
export function verifySigned(signed: string) {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  return sign(value) === signed ? value : null;
}
