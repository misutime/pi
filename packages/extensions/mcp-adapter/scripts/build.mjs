import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf-8"));
const extName = pkg.name?.split("/").pop() || basename(srcDir);
const outDir = resolve(srcDir, "..", "..", "coding-agent", "extensions", extName);

// Vendor entry (git submodule at repo root)
const vendorEntry = resolve(
  srcDir, "..", "..", "..", "vendor", "pi-mcp-adapter", "index.ts",
);

// Ensure output dir exists before esbuild and file writes
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [vendorEntry],
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
    "recheck",
  ],
});

// Copy runtime asset: app-bridge.bundle.js
const assetSrc = join(
  srcDir, "..", "..", "..", "vendor", "pi-mcp-adapter", "app-bridge.bundle.js",
);
copyFileSync(assetSrc, join(outDir, "app-bridge.bundle.js"));

const manifest = {
  pi: { extensions: ["./index.js"] },
};
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, private: true, type: "module", ...manifest },
    null,
    2,
  ) + "\n",
);

console.log(`Built ${extName} -> ${outDir}`);
