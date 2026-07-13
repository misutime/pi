import { randomUUID } from "node:crypto";
import type { JsonRpcPeer } from "../rpc/peer.ts";
import type {
	LspDefinitionResult,
	LspDiagnostic,
	LspDidChangeParams,
	LspDidOpenParams,
	LspDocumentSymbol,
	LspHover,
	LspInitializeResult,
	LspLocation,
	LspPosition,
	LspPublishDiagnosticsParams,
} from "./types.ts";

// ============================================================================
// LspClient
// ============================================================================

/**
 * LSP 客户端。
 *
 * 封装 LSP 协议的 initialize / shutdown / textDocument 方法。
 * 通过 JsonRpcPeer 与 LSP server 通信（底层 transport 已由 ProcessManager 建立）。
 */
export class LspClient {
	private _peer: JsonRpcPeer;
	private _rootUri: string;
	private _serverCapabilities: Record<string, unknown> = {};
	private _openDocs = new Map<string, { version: number; languageId: string }>();
	/** publishDiagnostics 通知缓存：uri → diagnostics */
	private _diagCache = new Map<string, LspDiagnostic[]>();

	/**
	 * @param peer - JsonRpcPeer，已 start()，绑定到 LSP server 的 StdioJsonRpcTransport
	 * @param rootUri - 项目根目录 URI (file:///path/to/project)
	 */
	constructor(peer: JsonRpcPeer, rootUri: string) {
		this._peer = peer;
		this._rootUri = rootUri;

		// Subscribe to publishDiagnostics notifications (push model).
		this._peer.onNotification("textDocument/publishDiagnostics", (params) => {
			const p = params as LspPublishDiagnosticsParams;
			this._diagCache.set(p.uri, p.diagnostics);
		});
	}

	// ========================
	// 生命周期
	// ========================

	/**
	 * 发送 initialize 请求，协商能力。
	 * 必须在其他任何请求之前调用。
	 *
	 * LSP 规范：initialize → initialized 通知 → 正常通信
	 */
	async initialize(): Promise<LspInitializeResult> {
		const result = await this._peer.request<LspInitializeResult>("initialize", {
			processId: process.pid,
			rootUri: this._rootUri,
			capabilities: {
				textDocument: {
					definition: { linkSupport: false },
					references: {},
					hover: { contentFormat: ["plaintext", "markdown"] },
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					publishDiagnostics: {},
				},
				workspace: {
					symbol: {},
				},
			},
		});

		this._serverCapabilities = result.capabilities || {};

		// Send initialized notification (required by LSP spec after initialize response).
		this._peer.notify("initialized", {});

		return result;
	}

	/**
	 * 发送 shutdown 请求 + exit 通知。
	 * 调用后此 client 不可再用。
	 */
	async shutdown(): Promise<void> {
		await this._peer.request("shutdown", {});
		this._peer.notify("exit", {});
	}

	// ========================
	// 文档同步
	// ========================

	/**
	 * 通知 server 文档已打开。
	 * 之后才能对该文档做 definition/references 等查询。
	 */
	notifyDidOpen(params: LspDidOpenParams): void {
		this._openDocs.set(params.textDocument.uri, {
			version: params.textDocument.version,
			languageId: params.textDocument.languageId,
		});
		this._peer.notify("textDocument/didOpen", params);
	}

	/**
	 * 通知 server 文档内容变更。
	 * Agent 每次 edit 后调用。
	 */
	notifyDidChange(params: LspDidChangeParams): void {
		const doc = this._openDocs.get(params.textDocument.uri);
		if (doc) {
			doc.version = params.textDocument.version;
		}
		this._peer.notify("textDocument/didChange", params);
	}

	// ========================
	// 核心查询
	// ========================

	/**
	 * textDocument/definition — 跳转到定义。
	 */
	async definition(uri: string, position: LspPosition): Promise<LspDefinitionResult> {
		return this._peer.request<LspDefinitionResult>("textDocument/definition", {
			textDocument: { uri },
			position,
		});
	}

	/**
	 * textDocument/references — 查找所有引用。
	 */
	async references(uri: string, position: LspPosition, includeDeclaration: boolean): Promise<LspLocation[]> {
		const result = await this._peer.request<LspLocation[] | null>("textDocument/references", {
			textDocument: { uri },
			position,
			context: { includeDeclaration },
		});
		return result ?? [];
	}

	/**
	 * textDocument/hover — 获取光标位置的类型信息、文档等。
	 */
	async hover(uri: string, position: LspPosition): Promise<LspHover | null> {
		return this._peer.request<LspHover | null>("textDocument/hover", {
			textDocument: { uri },
			position,
		});
	}

	/**
	 * textDocument/documentSymbol — 获取文档的符号大纲。
	 */
	async documentSymbols(uri: string): Promise<LspDocumentSymbol[]> {
		const result = await this._peer.request<LspDocumentSymbol[] | null>("textDocument/documentSymbol", {
			textDocument: { uri },
		});
		return result ?? [];
	}

	// ========================
	// Diagnostics
	// ========================

	/**
	 * 获取文档的诊断信息。
	 *
	 * 策略：
	 * 1. 如果 server capabilities 支持 pull diagnostics → textDocument/diagnostic
	 * 2. 否则使用 publishDiagnostics 通知的缓存
	 */
	async diagnostics(uri: string): Promise<LspDiagnostic[]> {
		// Try pull model first.
		const caps = this._serverCapabilities as Record<string, unknown>;
		const diagProvider = caps?.diagnosticProvider as Record<string, unknown> | undefined;
		if (diagProvider) {
			const id = randomUUID();
			const result = await this._peer.request<{ items: LspDiagnostic[] } | null>("textDocument/diagnostic", {
				textDocument: { uri },
				identifier: id,
			});
			if (result?.items) return result.items;
		}

		// Fallback: cached publishDiagnostics.
		return this._diagCache.get(uri) ?? [];
	}
}
