import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 自动发现并构建所有内置扩展。
 * 从 repo 根目录固定解析 packages/extensions/，不依赖 cwd。
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = resolve(repoRoot, "packages", "extensions");

let built = 0;
for (const name of readdirSync(srcDir, { withFileTypes: true })) {
	if (!name.isDirectory()) continue;
	const dir = join(srcDir, name.name);
	const pkgJson = join(dir, "package.json");
	if (!existsSync(pkgJson)) continue;

	const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
	if (!pkg.scripts?.build) continue;

	console.log(`Building built-in extension: ${name.name}`);
	execSync("npm run build", { cwd: dir, stdio: "inherit" });
	built++;
}

if (built === 0) {
	console.log("No built-in extensions to build.");
}
