import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config.js";

export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string) {
  if (key.includes("..") || path.isAbsolute(key)) throw new Error("Invalid storage key");
  return key;
}

class LocalStorage implements Storage {
  constructor(private root: string) {}
  private p(key: string) { return path.join(this.root, safeKey(key)); }
  async put(key: string, data: Buffer) {
    await fs.mkdir(path.dirname(this.p(key)), { recursive: true });
    await fs.writeFile(this.p(key), data);
  }
  get(key: string) { return fs.readFile(this.p(key)); }
  async delete(key: string) { await fs.rm(this.p(key), { force: true }); }
}

class S3Storage implements Storage {
  private c: S3Client;
  constructor(private bucket: string) {
    this.c = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
        : {}),
    });
  }
  async put(key: string, data: Buffer) {
    await this.c.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data }));
  }
  async get(key: string) {
    const r = await this.c.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.c.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
}

export const storage: Storage =
  env.STORAGE_PROVIDER === "s3"
    ? new S3Storage(env.S3_BUCKET ?? (() => { throw new Error("S3_BUCKET required") })())
    : new LocalStorage(path.resolve(env.STORAGE_PATH));
