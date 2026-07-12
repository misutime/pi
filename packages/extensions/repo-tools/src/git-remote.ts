/**
 * 从当前工作目录推断 GitHub 仓库（owner/repo）。
 */

import { execFile } from "node:child_process";

interface GitHubRepo {
	owner: string;
	repo: string;
}

export async function inferRepoFromCwd(): Promise<GitHubRepo | null> {
	let stdout: string;
	try {
		const result = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["remote", "get-url", "origin"],
				{ timeout: 5000 },
				(err, out, stderr) => {
					if (err) {
						reject(new Error(stderr.trim() || err.message));
					} else {
						resolve(out.trim());
					}
				},
			);
		});
		stdout = result;
	} catch {
		return null;
	}

	return parseGitRemote(stdout);
}

function parseGitRemote(remote: string): GitHubRepo | null {
	// HTTPS: https://github.com/owner/repo.git
	// SSH:   git@github.com:owner/repo.git
	const httpsMatch = remote.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/\s.]+?)(?:\.git)?$/i,
	);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}

	const sshMatch = remote.match(
		/^git@github\.com:([^/]+)\/([^/\s.]+?)(?:\.git)?$/i,
	);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}

	return null;
}
