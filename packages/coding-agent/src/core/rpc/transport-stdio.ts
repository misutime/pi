import type { ChildProcess } from "node:child_process";
import type { RpcTransport } from "./transport.ts";
import type { RpcMessage } from "./types.ts";

/**
 * Stdio JSON-RPC transport with LSP Content-Length framing.
 *
 * Binds to an already-spawned ChildProcess (owned by ProcessManager).
 * Parses the LSP header+body format on stdout, writes framed messages to stdin.
 *
 * Does NOT spawn or kill the process — lifecycle is managed externally.
 */
export class StdioJsonRpcTransport implements RpcTransport {
	private _child: ChildProcess;
	private _buffer: Buffer = Buffer.alloc(0);
	private _messageHandlers: Array<(message: RpcMessage) => void> = [];
	private _closeHandlers: Array<() => void> = [];
	private _errorHandlers: Array<(err: Error) => void> = [];
	private _stdoutDataHandler: ((chunk: Buffer) => void) | undefined;
	private _exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
	private _errorEventHandler: ((err: Error) => void) | undefined;

	/**
	 * @param child - 已 spawn 的 LSP server 进程（ProcessManager 持有所有权）
	 */
	constructor(child: ChildProcess) {
		this._child = child;
	}

	start(): void {
		// Parse LSP Content-Length framing from stdout.
		this._stdoutDataHandler = (chunk: Buffer) => {
			this._buffer = Buffer.concat([this._buffer, chunk]);
			this._parseFrames();
		};
		this._child.stdout?.on("data", this._stdoutDataHandler);

		// Propagate process exit as transport close.
		this._exitHandler = () => {
			this._emitClose();
		};
		this._child.on("exit", this._exitHandler);

		// Propagate process error events (broken pipe, spawn failure, etc).
		this._errorEventHandler = (err: Error) => {
			for (const handler of this._errorHandlers) {
				handler(err);
			}
		};
		this._child.on("error", this._errorEventHandler);
	}

	send(message: RpcMessage): boolean {
		const stdin = this._child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			return false;
		}
		try {
			const json = JSON.stringify(message);
			const length = Buffer.byteLength(json, "utf-8");
			stdin.write(`Content-Length: ${length}\r\n\r\n${json}`, "utf-8");
			return true;
		} catch {
			return false;
		}
	}

	onMessage(handler: (message: RpcMessage) => void): () => void {
		this._messageHandlers.push(handler);
		return () => {
			const index = this._messageHandlers.indexOf(handler);
			if (index !== -1) this._messageHandlers.splice(index, 1);
		};
	}

	onClose(handler: () => void): () => void {
		this._closeHandlers.push(handler);
		return () => {
			const index = this._closeHandlers.indexOf(handler);
			if (index !== -1) this._closeHandlers.splice(index, 1);
		};
	}

	onError(handler: (err: Error) => void): () => void {
		this._errorHandlers.push(handler);
		return () => {
			const index = this._errorHandlers.indexOf(handler);
			if (index !== -1) this._errorHandlers.splice(index, 1);
		};
	}

	/**
	 * Close the transport layer (clean up listeners, end stdin).
	 * Does NOT kill the process — process lifecycle is managed by ProcessManager.
	 */
	close(): void {
		if (this._stdoutDataHandler && this._child.stdout) {
			this._child.stdout.removeListener("data", this._stdoutDataHandler);
			this._stdoutDataHandler = undefined;
		}
		if (this._exitHandler) {
			this._child.removeListener("exit", this._exitHandler);
			this._exitHandler = undefined;
		}
		if (this._errorEventHandler) {
			this._child.removeListener("error", this._errorEventHandler);
			this._errorEventHandler = undefined;
		}
		// End stdin to signal no more messages, but don't kill the process.
		try {
			this._child.stdin?.end();
		} catch {
			/* ignore — stdin may already be closed */
		}
		this._messageHandlers = [];
		this._closeHandlers = [];
		this._errorHandlers = [];
	}

	private _emitClose(): void {
		for (const handler of this._closeHandlers) {
			handler();
		}
	}

	// ====================================================================
	// Content-Length framing parser
	// ====================================================================

	/**
	 * Parse complete messages from the accumulated buffer.
	 * Each message: "Content-Length: N\r\n\r\n{json}"
	 * May contain multiple messages in one data chunk (粘包) or partial
	 * messages that arrive across multiple data events (半包).
	 */
	private _parseFrames(): void {
		while (this._buffer.length > 0) {
			const headerEnd = this._buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				// Incomplete header — wait for more data.
				return;
			}

			const header = this._buffer.subarray(0, headerEnd).toString("utf-8");
			const match = header.match(/^Content-Length: (\d+)$/im);
			if (!match) {
				// Malformed header — skip past the header separator and retry.
				this._buffer = this._buffer.subarray(headerEnd + 4);
				// Emit error to handlers.
				for (const handler of this._errorHandlers) {
					handler(new Error(`Malformed LSP frame header: ${header}`));
				}
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			if (Number.isNaN(contentLength) || contentLength < 0) {
				this._buffer = this._buffer.subarray(headerEnd + 4);
				for (const handler of this._errorHandlers) {
					handler(new Error(`Invalid Content-Length: ${match[1]}`));
				}
				continue;
			}

			const bodyStart = headerEnd + 4;
			const totalNeeded = bodyStart + contentLength;
			if (this._buffer.length < totalNeeded) {
				// Incomplete body — wait for more data.
				return;
			}

			const body = this._buffer.subarray(bodyStart, totalNeeded).toString("utf-8");
			this._buffer = this._buffer.subarray(totalNeeded);

			try {
				const message = JSON.parse(body) as RpcMessage;
				// Only dispatch JSON-RPC messages.
				if (message && typeof message === "object" && "jsonrpc" in message) {
					for (const handler of this._messageHandlers) {
						handler(message);
					}
				}
			} catch (err) {
				for (const handler of this._errorHandlers) {
					handler(
						new Error(`Failed to parse LSP frame body: ${err instanceof Error ? err.message : String(err)}`),
					);
				}
			}
		}
	}
}
