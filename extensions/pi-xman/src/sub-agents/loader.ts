/**
 * Agent loader — reads agent markdown files from ~/.pi/agent/agents/.
 */

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentConfig } from "./types.ts";

export function loadAgentsFromDir(): { agents: IAgentConfig[]; errors: string[] } {
  const dir = path.join(getAgentDir(), "agents");

  const agents: IAgentConfig[] = [];
  const errors: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { agents, errors };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      errors.push(`${filePath}: 无法读取文件 (${err?.message ?? "未知错误"})`);
      continue;
    }

    let frontmatter: Record<string, string | string[]>;
    let body: string;
    try {
      const parsed = parseFrontmatter<Record<string, string | string[]>>(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (err: any) {
      errors.push(`${filePath}: YAML 解析失败 (${err?.message ?? "未知错误"})`);
      continue;
    }

    // name and description are required
    if (!frontmatter.name) {
      errors.push(`${filePath}: 缺少 name 字段`);
      continue;
    }
    if (!frontmatter.description) {
      errors.push(`${filePath}: 缺少 description 字段`);
      continue;
    }

    // Tools: accept comma-separated string ("bash, read") or YAML list (["bash", "read"])
    const rawTools = frontmatter.tools;
    let toolList: string[];
    if (Array.isArray(rawTools)) {
      const invalidTools: number[] = [];
      toolList = rawTools
        .map((t, i) => {
          if (typeof t !== "string") {
            invalidTools.push(i);
            return "";
          }
          return t.trim();
        })
        .filter(Boolean);
      if (invalidTools.length > 0) {
        errors.push(
          `${filePath}: tools 第 ${invalidTools.map((i) => i + 1).join(", ")} 项不是字符串`,
        );
      }
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

  return { agents, errors };
}
