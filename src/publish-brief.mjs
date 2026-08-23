#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";
import { readJson } from "./utils.mjs";

function run(file, args, { input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

async function record(args) {
  return run(process.execPath, [join(projectRoot, "src/cli.mjs"), "brief-record-publication", ...args]);
}

const config = await loadConfig();
const date = process.env.BRIEF_DATE ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const prepared = await run(process.execPath, [join(projectRoot, "src/cli.mjs"), "brief"]);
if (!prepared.ok) throw new Error("morning brief preparation failed");

const metadataPath = join(config.data_dir, "briefs", `${date}.json`);
const briefPath = join(config.data_dir, "briefs", `${date}.md`);
const metadata = await readJson(metadataPath, null);
if (!metadata) throw new Error("morning brief metadata is missing");
if (metadata.published) {
  process.stdout.write(`${JSON.stringify({ status: "already_published", date })}\n`);
  process.exit(0);
}

const publisher = config.briefing.publisher;
const keychain = await run("/usr/bin/security", ["find-generic-password", "-w", "-s", publisher.keychain_service, "-a", publisher.keychain_account]);
if (!keychain.ok) throw new Error("publisher Keychain identity is unavailable");
const privateKey = JSON.parse(keychain.stdout)[`agent:${publisher.pubkey}`];
if (typeof privateKey !== "string" || privateKey.length < 32) throw new Error("publisher private key is missing");

const agentsPath = "/Users/lukesmacminim41/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json";
const agents = JSON.parse(await readFile(agentsPath, "utf8"));
const authTag = agents.find((agent) => agent.pubkey === publisher.pubkey)?.auth_tag;
if (typeof authTag !== "string" || authTag.length < 16) throw new Error("publisher owner attestation is missing");

const content = await readFile(briefPath, "utf8");
const sent = await run("/Users/lukesmacminim41/.local/bin/buzz", ["--relay", publisher.relay_url, "messages", "send", "--channel", config.channel.id, "--content", "-"], { input: content, env: { ...process.env, BUZZ_PRIVATE_KEY: privateKey, BUZZ_AUTH_TAG: authTag } });
if (!sent.ok) {
  await record(["--date", date, "--content-hash", metadata.content_hash, "--status", "failure", "--error-code", "relay_send_failed"]);
  process.stdout.write(`${JSON.stringify({ status: "failed", date, error_code: "relay_send_failed" })}\n`);
  process.exit(1);
}

const result = JSON.parse(sent.stdout);
const eventId = result.id ?? result.event_id ?? result.event?.id ?? result.message?.id;
if (!eventId) {
  await record(["--date", date, "--content-hash", metadata.content_hash, "--status", "failure", "--error-code", "relay_result_missing_event_id"]);
  throw new Error("relay result did not contain an event id");
}
const recorded = await record(["--date", date, "--content-hash", metadata.content_hash, "--status", "success", "--event-id", eventId]);
if (!recorded.ok) throw new Error("published brief could not be recorded");
process.stdout.write(`${JSON.stringify({ status: "published", date, event_id: eventId })}\n`);
