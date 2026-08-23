import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value), "utf8").digest("hex");
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

export async function readJson(path, fallback = undefined) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function atomicWrite(path, text) {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

export async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export async function withLock(path, fn, { attempts = 100, delayMs = 10, staleMs = 30000 } = {}) {
  await ensureDir(dirname(path));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(path);
      try { return await fn(); }
      finally { await rm(path, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > staleMs) await rm(path, { recursive: true, force: true });
      } catch (statError) { if (statError?.code !== "ENOENT") throw statError; }
      await sleep(delayMs);
    }
  }
  throw new Error(`lock timeout: ${path}`);
}

const secretKeyPattern = /^(?:.*(?:token|secret|password|passphrase|credential|authorization|cookie)|(?:private|public|api)[_-]?key|auth)$/i;
const secretValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}/g,
];

export function redactSecrets(value, key = "") {
  if (secretKeyPattern.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSecrets(childValue, childKey)]));
  }
  if (typeof value !== "string") return value;
  return secretValuePatterns.reduce((text, pattern) => text.replace(pattern, "<redacted>"), value);
}

export function resolveFrom(baseFile, target) {
  return resolve(dirname(baseFile), target);
}

export function nowIso(clock = Date) { return new clock().toISOString(); }
