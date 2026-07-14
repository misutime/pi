import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * 构建内置扩展：esbuild 打包源码 → coding-agent/extensions/<name>/index.js。
 *
 * 用法：在扩展的 package.json 中设置 build 脚本：
 *   "build": "node ../../../scripts/build-extension.mjs"
 *
 * 或直接 node 调用：
 *   node scripts/build-extension.mjs
 *
 * 当前目录必须包含 package.json 和 src/index.ts。
 */

const srcDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf-8"));
const extName = pkg.name?.split("/").pop() || basename(srcDir);
const outDir = resolve(srcDir, "..", "..", "coding-agent", "extensions", extName);

await esbuild.build({
	entryPoints: [join(srcDir, "src", "index.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	mainFields: ["module", "main"],
	target: "node22",
	outfile: join(outDir, "index.js"),
	banner: {
		js: 'import { createRequire as __piCreateRequire } from "node:module"; var require = __piCreateRequire(import.meta.url);',
	},
	external: [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
		"typebox",
		"canvas",
		"*.node",
	],
});

const manifest = {
	pi: { extensions: ["./index.js"] },
};
writeFileSync(
	join(outDir, "package.json"),
	JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", ...manifest }, null, 2) + "\n",
);

console.log(`Built ${extName} → ${outDir}`);
