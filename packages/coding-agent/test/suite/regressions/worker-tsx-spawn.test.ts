/**
 * Regression: verify that the subagent worker can be spawned via tsx
 * with working IPC. The previous approach using --import tsx/esm caused
 * JSON parse errors when extensions depended on mime-db (CJS require of .json).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mirror resolveTsxCliPath logic from runtime.ts — walk up to find node_modules/tsx
function findTsxCli(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("tsx CLI not found in node_modules");
}

describe("subagent worker spawn", () => {
	it("resolveTsxCliPath finds tsx CLI in node_modules", () => {
		const tsxCli = findTsxCli();
		expect(existsSync(tsxCli)).toBe(true);
		expect(tsxCli).toContain("tsx");
	});

	it("spawn via tsx works with IPC round-trip", async () => {
		const tmpDir = join(tmpdir(), `pi-test-worker-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		const workerScript = join(tmpDir, "test-worker.ts");
		writeFileSync(
			workerScript,
			[
				"",
				"process.once(",
				'  "message",',
				"  (msg: any) => {",
				"    if (msg && msg.method === 'echo') {",
				"      process.send!({",
				'        jsonrpc: "2.0",',
				"        id: msg.id,",
				'        result: { echo: msg.params?.text ?? "ok", pid: process.pid },',
				"      });",
				"      process.exit(0);",
				"    }",
				"  },",
				");",
				"",
			].join("\n"),
		);

		try {
			const tsxCli = findTsxCli();

			const child = spawn(process.execPath, [tsxCli, workerScript], {
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});

			const result = await new Promise<{ echo: string; pid: number }>((resolve, reject) => {
				const timeout = setTimeout(() => {
					child.kill();
					reject(new Error("Worker timed out"));
				}, 15_000);

				child.on("message", (msg: any) => {
					clearTimeout(timeout);
					if (msg?.result) {
						resolve(msg.result);
					} else {
						reject(new Error(`Unexpected message: ${JSON.stringify(msg)}`));
					}
				});

				child.on("error", (err) => {
					clearTimeout(timeout);
					reject(err);
				});

				child.on("exit", (code) => {
					if (code !== 0 && code !== null) {
						clearTimeout(timeout);
						reject(new Error(`Worker exited with code ${code}`));
					}
				});

				child.send({ jsonrpc: "2.0", id: "1", method: "echo", params: { text: "hello" } });
			});

			expect(result.echo).toBe("hello");
			expect(result.pid).toBeGreaterThan(0);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 20_000);
});
