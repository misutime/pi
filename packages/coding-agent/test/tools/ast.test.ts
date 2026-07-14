import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AstToolInput } from "../../src/core/tools/ast/index.ts";
import { createAstToolDefinition } from "../../src/core/tools/ast/index.ts";

describe("ast tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ast-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createDef() {
		return createAstToolDefinition(tempDir);
	}

	function writeTs(file: string, content: string): string {
		const filePath = join(tempDir, file);
		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	async function runAst(params: Partial<AstToolInput>, signal?: AbortSignal) {
		const def = createDef();
		const ctx = {} as Parameters<typeof def.execute>[4];
		return def.execute("call-1", params as AstToolInput, signal, undefined, ctx);
	}

	// === Schema & validation tests (no sg binary needed) ===

	it("creates a tool definition named 'ast'", () => {
		const def = createDef();
		expect(def.name).toBe("ast");
		expect(def.label).toBe("ast");
	});

	it("schema uses Integer for limit", () => {
		const def = createDef();
		const schema = def.parameters as unknown as Record<string, unknown>;
		const props = schema.properties as Record<string, unknown>;
		const limitProp = props.limit as Record<string, unknown>;
		expect(limitProp.type).toBe("integer");
		expect(limitProp.minimum).toBe(1);
	});

	it("rejects directory search without language", async () => {
		await expect(runAst({ pattern: "test", path: "/" })).rejects.toThrow("language parameter is required");
	});

	it("rejects project-wide search without language", async () => {
		await expect(runAst({ pattern: "test" })).rejects.toThrow("language parameter is required");
	});

	it("rejects non-existent path", async () => {
		await expect(runAst({ pattern: "test", path: "/nonexistent/path/file.ts" })).rejects.toThrow("Path not found");
	});

	it("aborts before spawn when signal is already aborted", async () => {
		writeTs("a.ts", "const x = 1;\n");
		const ac = new AbortController();
		ac.abort();
		await expect(runAst({ pattern: "const $X = $$$", path: "a.ts" }, ac.signal)).rejects.toThrow("Operation aborted");
	});

	// === sg integration tests (require sg binary in PATH or auto-download) ===

	it("returns matches with 1-based line numbers and captures", async () => {
		writeTs("sample.ts", `function login(name: string, pwd: string) {\n  console.log("auth");\n}\n`);
		const result = await runAst({ pattern: "function $NAME($$$) { $$$ }", path: "sample.ts" });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("sample.ts:1:");
		expect(text).toContain("login");
		expect(text).toContain("NAME: login");
	});

	it("reports matchLimitReached only when killed by limit, not natural end", async () => {
		// 10 matches total, limit=5 → should report matchLimitReached.
		const manyLines = Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`);
		writeTs("many.ts", manyLines.join("\n"));
		const result1 = await runAst({ pattern: "const $X = $$$", path: "many.ts", limit: 5 });
		expect(result1.details?.matchLimitReached).toBe(5);

		// Exactly 5 matches, limit=5 → sg finishes naturally, no matchLimitReached.
		const exactLines = Array.from({ length: 5 }, (_, i) => `const x${i} = ${i};`);
		writeTs("exact.ts", exactLines.join("\n"));
		const result2 = await runAst({ pattern: "const $X = $$$", path: "exact.ts", limit: 5 });
		expect(result2.details?.matchLimitReached).toBeUndefined();
	});

	it("truncates float limit to integer", async () => {
		const lines = Array.from({ length: 5 }, (_, i) => `const x${i} = ${i};`);
		writeTs("float.ts", lines.join("\n"));
		// Pass 2.5 as limit — should truncate to 2.
		const result = await runAst({
			pattern: "const $X = $$$",
			path: "float.ts",
			limit: 2.5 as unknown as number,
		});
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		const outputLines = text.split("\n").filter((l: string) => l.trim());
		expect(outputLines.length).toBeLessThanOrEqual(2);
	});

	it("truncates zero or negative limit to 1", async () => {
		writeTs("one.ts", "const a = 1;\nconst b = 2;\n");
		const result = await runAst({
			pattern: "const $X = $$$",
			path: "one.ts",
			limit: 0 as unknown as number,
		});
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		const outputLines = text.split("\n").filter((l: string) => l.trim());
		expect(outputLines.length).toBe(1);
	});

	it("aborts running search mid-execution", async () => {
		const count = 10000;
		const lines = Array.from({ length: count }, (_, i) => `const x${i} = ${i};`);
		writeTs("big.ts", lines.join("\n"));

		const ac = new AbortController();
		const promise = runAst({ pattern: "const $X = $$$", path: "big.ts", limit: count }, ac.signal);
		setTimeout(() => ac.abort(), 10);
		await expect(promise).rejects.toThrow("Operation aborted");
	});

	it("close event reads all stdout (no truncation)", async () => {
		const count = 200;
		const lines = Array.from({ length: count }, (_, i) => `const x${i} = ${i};`);
		writeTs("all.ts", lines.join("\n"));

		const result = await runAst({ pattern: "const $X = $$$", path: "all.ts", limit: 500 });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		const outputLines = text.split("\n").filter((l: string) => l.trim());
		expect(outputLines.length).toBe(count);
	});
});
