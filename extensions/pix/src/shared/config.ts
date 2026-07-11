import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

interface PixConfig {}

export function getPixConfigDir(): string {
  return join(homedir(), ".pi");
}
export function getPixConfigPath(): string {
  return join(getPixConfigDir(), "pix-config.json");
}
const PIX_CONFIG_PATH = getPixConfigPath();

export function loadConfig(): PixConfig {
  if (!existsSync(PIX_CONFIG_PATH)) return {};
  const raw = readFileSync(PIX_CONFIG_PATH, "utf-8");
  try {
    return JSON.parse(raw) as PixConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${PIX_CONFIG_PATH}: ${message}`);
  }
}
