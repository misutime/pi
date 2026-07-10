/**
 * Agent loader — reads agent markdown files from ~/.pi/agent/agents/.
 */

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentConfig } from "./types.ts";

export function loadAgentsFromDir(): IAgentConfig[] {
  const dir = path.join(getAgentDir(), "agents");

  const agents: IAgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = (() => {
      try {
        return parseFrontmatter<Record<string, string | string[]>>(content);
      } catch {
        return { frontmatter: {} as Record<string, string | string[]>, body: content };
      }
    })();

    // name and description are required
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    // Tools: accept comma-separated string ("bash, read") or YAML list (["bash", "read"])
    const rawTools = frontmatter.tools;
    let toolList: string[];
    if (Array.isArray(rawTools)) {
      toolList = rawTools
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (typeof rawTools === "string") {
      toolList = rawTools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      toolList = [];
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: toolList,
      model: frontmatter.model,
      systemPrompt: body,
      filePath,
    });
  }

  return agents;
}
