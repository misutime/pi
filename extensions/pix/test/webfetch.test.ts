import { describe, expect, it, vi } from "vitest";
import { applyTruncation, raceWithAbort } from "../src/tools/webtools/format.ts";

// ============================================================================
// format.ts
// ============================================================================

describe("applyTruncation", () => {
	it("returns content unchanged when under limits", () => {
		const text = "short text";
		const result = applyTruncation(text, "test");
		expect(result).toBe(text);
	});

	it("returns a string", () => {
		const result = applyTruncation("content", "page");
		expect(typeof result).toBe("string");
	});
});

describe("raceWithAbort", () => {
	it("returns promise result when signal is not provided", async () => {
		const result = await raceWithAbort(Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("returns promise result when signal is not aborted", async () => {
		const controller = new AbortController();
		const result = await raceWithAbort(Promise.resolve("ok"), controller.signal);
		expect(result).toBe("ok");
	});

	it("rejects when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			raceWithAbort(Promise.resolve("never"), controller.signal),
		).rejects.toThrow();
	});

	it("rejects when signal aborts before promise resolves", async () => {
		const controller = new AbortController();
		const promise = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100));

		setTimeout(() => controller.abort(), 10);

		await expect(
			raceWithAbort(promise, controller.signal),
		).rejects.toThrow();
	});

	it("rejects with promise error when signal not aborted", async () => {
		const controller = new AbortController();
		await expect(
			raceWithAbort(Promise.reject(new Error("fail")), controller.signal),
		).rejects.toThrow("fail");
	});
});

// ============================================================================
// webtools/fetch.ts 结构测试
// ============================================================================

describe("webfetch tool registration", () => {
	it("registers a tool named webfetch", async () => {
		const { default: webfetch } = await import("../src/tools/webtools/fetch.ts");

		const mockPi = {
			registerTool: vi.fn(),
		};

		webfetch(mockPi as any);

		expect(mockPi.registerTool).toHaveBeenCalledTimes(1);
		const call = mockPi.registerTool.mock.calls[0][0];
		expect(call.name).toBe("webfetch");
		expect(call.label).toBe("Web Fetch");
		expect(call.parameters).toBeDefined();
		expect(call.execute).toBeInstanceOf(Function);
	});
});

// ============================================================================
// webtools/search.ts 结构测试
// ============================================================================

describe("websearch tool registration", () => {
	it("registers a tool named websearch", async () => {
		const { default: websearch } = await import("../src/tools/webtools/search.ts");

		const mockPi = {
			registerTool: vi.fn(),
		};

		websearch(mockPi as any);

		expect(mockPi.registerTool).toHaveBeenCalledTimes(1);
		const call = mockPi.registerTool.mock.calls[0][0];
		expect(call.name).toBe("websearch");
		expect(call.label).toBe("Web Search");
		expect(call.parameters).toBeDefined();
		expect(call.execute).toBeInstanceOf(Function);
	});
});
