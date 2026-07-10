import { describe, expect, it } from "vitest";
import { fetchContent } from "../src/webfetch/fetch.ts";

describe("webfetch", () => {
	describe("fetchContent", () => {
		it("fetches a real URL and returns text", async () => {
			const result = await fetchContent("https://example.com");

			expect(result.status).toBe(200);
			expect(result.url).toBe("https://example.com/");
			expect(result.contentType).toContain("text/html");
			expect(result.text).toBeTruthy();
			expect(typeof result.text).toBe("string");
			expect(result.truncated).toBe(false);
		}, 10_000);

		it("rejects on invalid URLs", async () => {
			await expect(fetchContent("not-a-url")).rejects.toThrow();
		});

		it("handles 404 with readable text", async () => {
			const result = await fetchContent("https://example.com/nonexistent-page-abc123xyz");

			expect(result.status).toBe(404);
			expect(result.text).toBeTruthy();
		}, 10_000);

		it("returns a boolean for truncated flag", async () => {
			const result = await fetchContent("https://example.com");
			expect(typeof result.truncated).toBe("boolean");
		}, 10_000);

		it("handles AbortSignal", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				fetchContent("https://example.com", controller.signal),
			).rejects.toThrow();
		});
	});
});
