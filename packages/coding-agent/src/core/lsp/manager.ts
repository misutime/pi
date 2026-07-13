import { pathToFileURL } from "node:url";
import type { ProcessManager, SpawnConfig } from "../process-manager.ts";
import { JsonRpcPeer } from "../rpc/peer.ts";
import { StdioJsonRpcTransport } from "../rpc/transport-stdio.ts";
import { LspClient } from "./client.ts";

/**
 * 语言 → LSP server 映射。
 * 仅列出有对应 server 的语言。user 环境未安装该 server 时，getOrStart 返回 null。
 */
const LSP_SERVERS: Record<string, SpawnConfig> = {
	typescript: { command: "typescript-language-server", args: ["--stdio"] },
	javascript: { command: "typescript-language-server", args: ["--stdio"] },
	tsx: { command: "typescript-language-server", args: ["--stdio"] },
	rust: { command: "rust-analyzer", args: [] },
	python: { command: "basedpyright-langserver", args: ["--stdio"] },
	go: { command: "gopls", args: ["--stdio"] },
};

/**
 * LSP 客户端管理器。
 *
 * 按语言按需启动 LSP server，复用已有连接。
 * 内部持有 ProcessManager、transport、peer、LspClient 的完整生命周期。
 */
export class LspManager {
	private _pm: ProcessManager;
	private _rootUri: string;
	/** 语言 → LspClient 缓存 */
	private _clients = new Map<string, LspClient>();

	/**
	 * @param pm - ProcessManager 实例（应在 AgentSession 生命周期内共享）
	 * @param cwd - 工作目录（作为 LSP rootUri）
	 */
	constructor(pm: ProcessManager, cwd: string) {
		this._pm = pm;
		this._rootUri = pathToFileURL(cwd).href;
	}

	/**
	 * 按语言获取或启动 LspClient。
	 * 首次调用时 spawn server 并 initialize；后续复用。
	 * server 不存在或不支持时返回 null。
	 */
	async getOrStart(language: string): Promise<LspClient | null> {
		const cached = this._clients.get(language);
		if (cached) return cached;

		const config = LSP_SERVERS[language];
		if (!config) return null;

		try {
			const handle = await this._pm.getOrCreate({ workspace: this._rootUri, kind: "lsp", language }, config, {
				kind: "session",
				idleTimeoutMs: 15 * 60_000,
			});
			if (!handle.child) return null;

			const transport = new StdioJsonRpcTransport(handle.child);
			const peer = new JsonRpcPeer(transport);
			peer.start();
			const client = new LspClient(peer, this._rootUri);
			await client.initialize();
			this._clients.set(language, client);
			// Clear cache when the underlying process exits (idle stop, crash, etc).
			handle.onExit(() => {
				this._clients.delete(language);
			});
			return client;
		} catch {
			// Server not installed, spawn failed, etc.
			return null;
		}
	}

	/**
	 * 关闭所有 LSP 连接（Pi 退出时调用）。
	 */
	async shutdown(): Promise<void> {
		const clients = [...this._clients.values()];
		this._clients.clear();
		for (const client of clients) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
		}
	}
}
