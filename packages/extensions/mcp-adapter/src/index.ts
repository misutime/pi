import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Dynamic import via runtime URL to isolate vendor/ from root tsconfig type checking.
// The vendor code (git submodule) uses parameter properties, inline imports, and
// other patterns incompatible with this repo's erasableSyntaxOnly rules.
//
// ARCHITECTURE EXCEPTION: this file uses await import() inside the factory
// function, which would normally violate the repo's no-inline-imports rule.
// This is the minimal mechanism to load vendor/ code without letting root
// tsconfig statically follow into the submodule. No other file in src/ should
// use inline imports.
const vendorEntry = new URL(
  "../../../../vendor/pi-mcp-adapter/index.ts",
  import.meta.url,
).href;

export default async function mcpAdapter(pi: ExtensionAPI): Promise<void> {
  const mod = await import(vendorEntry);
  const factory = mod.default as (api: ExtensionAPI) => void;
  return factory(pi);
}
