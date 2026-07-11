import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

interface PixConfig {}

/** pi agent 目录下的 pix 配置路径，与 pi core 共享同一配置目录体系 */
export function getPixConfigPath(): string {
  return join(getAgentDir(), "pix-config.json");
}

export function loadConfig(): PixConfig {
  const configPath = getPixConfigPath();
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf-8");
  const errors: ParseError[] = [];
  const result = parse(raw, errors) as PixConfig;
  if (errors.length > 0) {
    const e = errors[0];
    throw new Error(
      `Failed to parse ${configPath} at offset ${e.offset}: ${printParseErrorCode(e.error)}`,
    );
  }
  return result;
}
