/**
 * Agent loader — reads agent markdown files from ~/.pi/agent/agents/.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { IAgentConfig } from "./types.ts";

export function loadAgentsFromDir(agentDir?: string): { agents: IAgentConfig[]; errors: string[] } {
	const dir = join(agentDir ?? getAgentDir(), "agents");

	const agents: IAgentConfig[] = [];
	const errors: string[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { agents, errors };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error";
			errors.push(`${filePath}: Cannot read file (${message})`);
			continue;
		}

		let frontmatter: Record<string, string | string[]>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, string | string[]>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error";
			errors.push(`${filePath}: YAML parse failed (${message})`);
			continue;
		}

		if (!frontmatter.name || typeof frontmatter.name !== "string") {
			errors.push(`${filePath}: Missing required 'name' field`);
			continue;
		}
		if (!frontmatter.description || typeof frontmatter.description !== "string") {
			errors.push(`${filePath}: Missing required 'description' field`);
			continue;
		}
		if (!frontmatter.model || typeof frontmatter.model !== "string") {
			errors.push(`${filePath}: Missing required 'model' field`);
			continue;
		}

		const rawTools = frontmatter.tools;
		let toolList: string[];
		if (Array.isArray(rawTools)) {
			toolList = rawTools.filter((t): t is string => typeof t === "string").map((t) => t.trim());
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
