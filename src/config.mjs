import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./utils.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig(path = resolve(projectRoot, "config/default.json")) {
  const config = await readJson(path);
  config.config_path = path;
  config.data_dir = resolve(projectRoot, config.data_dir);
  return config;
}
