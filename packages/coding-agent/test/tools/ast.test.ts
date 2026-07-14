import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	function writeFile(relPath: string, content: string): string {
		const filePath = join(tempDir, relPath);
		const dir = join(filePath, "..");
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	async function runAst(params: Partial<AstToolInput>, signal?: AbortSignal) {
		const def = createDef();
		const ctx = {} as Parameters<typeof def.execute>[4];
		return def.execute("call-1", params as AstToolInput, signal, undefined, ctx);
	}

	// === Schema & validation ===

	it("creates a tool definition named 'ast'", () => {
		const def = createDef();
		expect(def.name).toBe("ast");
	});

	it("schema includes pattern, path, language, globs, limit", () => {
		const def = createDef();
		const schema = def.parameters as unknown as Record<string, unknown>;
		const props = schema.properties as Record<string, unknown>;
		expect(props.pattern).toBeDefined();
		expect(props.path).toBeDefined();
		expect(props.language).toBeDefined();
		expect(props.globs).toBeDefined();
		expect(props.limit).toBeDefined();
		const limitProp = props.limit as Record<string, unknown>;
		expect(limitProp.type).toBe("integer");
		expect(limitProp.minimum).toBe(1);
	});

	it("rejects directory search without language", async () => {
		mkdirSync(join(tempDir, "sub"), { recursive: true });
		await expect(runAst({ pattern: "test", path: "sub" })).rejects.toThrow("language parameter is required");
	});

	it("rejects project-wide search without language", async () => {
		await expect(runAst({ pattern: "test" })).rejects.toThrow("language parameter is required");
	});

	it("rejects non-existent path", async () => {
		await expect(runAst({ pattern: "test", path: "/nonexistent/path/file.ts" })).rejects.toThrow("Path not found");
	});

	it("aborts before spawn when signal is already aborted", async () => {
		writeFile("a.ts", "const x = 1;\n");
		const ac = new AbortController();
		ac.abort();
		await expect(runAst({ pattern: "const $X = $$$", path: "a.ts" }, ac.signal)).rejects.toThrow("Operation aborted");
	});

	// === sg integration tests ===

	it("single file auto-detects language from extension (TS)", async () => {
		writeFile("sample.ts", `function login(name: string, pwd: string) {\n  console.log("auth");\n}\n`);
		const result = await runAst({ pattern: "function $NAME($$$) { $$$ }", path: "sample.ts" });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("sample.ts:1:");
		expect(text).toContain("login");
		expect(text).toContain("NAME: login");
	});

	it("single file with explicit language override", async () => {
		// sg auto-detects Python from .py; explicit -l is redundant but should work.
		writeFile("sample.py", "def greet(name):\n    return name\n");
		const result = await runAst({
			pattern: "def $NAME($$$): $$$",
			path: "sample.py",
			language: "python",
		});
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("sample.py:1:");
		expect(text).toContain("greet");
	});

	it("Python single file auto-detection", async () => {
		writeFile("app.py", "def greet(name):\n    return f'Hello {name}'\n");
		const result = await runAst({ pattern: "def $NAME($$$): $$$", path: "app.py" });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("app.py:1:");
		expect(text).toContain("greet");
	});

	it("Rust single file auto-detection", async () => {
		writeFile("lib.rs", 'fn hello() -> &\'static str {\n    "world"\n}\n');
		const result = await runAst({ pattern: "fn $NAME($$$) -> $$$ { $$$ }", path: "lib.rs" });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("lib.rs:1:");
		expect(text).toContain("hello");
	});

	it("Go single file auto-detection", async () => {
		writeFile("main.go", 'package main\n\nfunc greet(name string) string {\n\treturn "Hello " + name\n}\n');
		const result = await runAst({ pattern: "func $NAME($$$) $$$ { $$$ }", path: "main.go" });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("main.go:3:");
		expect(text).toContain("greet");
	});

	it("globs include/exclude filters files in directory search", async () => {
		mkdirSync(join(tempDir, "src"), { recursive: true });
		mkdirSync(join(tempDir, "vendor"), { recursive: true });
		writeFile("src/app.ts", "const app = 1;\n");
		writeFile("vendor/lib.ts", "const lib = 2;\n");

		// Include only **/src/*.ts, exclude **/vendor/**.
		const result = await runAst({
			pattern: "const $X = $$$",
			path: ".",
			language: "typescript",
			globs: ["**/src/*.ts", "!**/vendor/**"],
		});
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text).toContain("src/app.ts");
		expect(text).not.toContain("vendor");
	});

	it("honors limit and reports only when killed", async () => {
		// 10 matches total, limit=5 → matchLimitReached
		const manyLines = Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`);
		writeFile("many.ts", manyLines.join("\n"));
		const r1 = await runAst({ pattern: "const $X = $$$", path: "many.ts", limit: 5 });
		expect(r1.details?.matchLimitReached).toBe(5);

		// 5 matches, limit=5 → natural finish, no matchLimitReached
		const exactLines = Array.from({ length: 5 }, (_, i) => `const y${i} = ${i};`);
		writeFile("exact.ts", exactLines.join("\n"));
		const r2 = await runAst({ pattern: "const $X = $$$", path: "exact.ts", limit: 5 });
		expect(r2.details?.matchLimitReached).toBeUndefined();
	});

	it("truncates float limit to integer", async () => {
		writeFile("fl.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const r = await runAst({
			pattern: "const $X = $$$",
			path: "fl.ts",
			limit: 2.5 as unknown as number,
		});
		expect(r.details?.matchLimitReached).toBe(2);
	});

	it("truncates zero limit to 1", async () => {
		writeFile("z.ts", "const a = 1;\nconst b = 2;\n");
		const r = await runAst({
			pattern: "const $X = $$$",
			path: "z.ts",
			limit: 0 as unknown as number,
		});
		expect(r.details?.matchLimitReached).toBe(1);
	});

	it("aborts running search mid-execution", async () => {
		const count = 10000;
		const lines = Array.from({ length: count }, (_, i) => `const x${i} = ${i};`);
		writeFile("big.ts", lines.join("\n"));

		const ac = new AbortController();
		const promise = runAst({ pattern: "const $X = $$$", path: "big.ts", limit: count }, ac.signal);
		setTimeout(() => ac.abort(), 10);
		await expect(promise).rejects.toThrow("Operation aborted");
	});

	it("reads all stdout (close, no truncation)", async () => {
		const count = 200;
		const lines = Array.from({ length: count }, (_, i) => `const x${i} = ${i};`);
		writeFile("all.ts", lines.join("\n"));

		const result = await runAst({ pattern: "const $X = $$$", path: "all.ts", limit: 500 });
		const first = result.content[0];
		const text = first.type === "text" ? first.text : "";
		expect(text.split("\n").filter((l: string) => l.trim()).length).toBe(count);
	});
});
