import { randomUUID } from "node:crypto";
import type { RpcTransport } from "./transport.ts";
import type { RpcError, RpcMessage, RpcNotification, RpcRequest, RpcResponse } from "./types.ts";
import { ErrorCode, isNotification, isRequest, isResponse } from "./types.ts";

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: RpcError) => void;
	timeout: ReturnType<typeof setTimeout>;
	method: string;
}

export interface JsonRpcPeerOptions {
	/** Default timeout in ms for requests. Default: 30_000. */
	defaultTimeoutMs?: number;
}

export class JsonRpcPeer {
	private _transport: RpcTransport;
	private _pending = new Map<string | number, PendingRequest>();
	private _notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
	private _requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
	private _unsubTransport: (() => void) | undefined;
	private _defaultTimeoutMs: number;

	constructor(transport: RpcTransport, options?: JsonRpcPeerOptions) {
		this._transport = transport;
		this._defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
	}

	/** Start listening for messages. */
	start(): void {
		this._unsubTransport = this._transport.onMessage((msg) => this._handleMessage(msg));
		this._transport.start();
	}

	/** Register a method handler for incoming requests. */
	onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
		this._requestHandlers.set(method, handler);
	}

	/** Register a notification handler. Returns unsubscribe function. */
	onNotification(method: string, handler: (params: unknown) => void): () => void {
		const handlers = this._notificationHandlers.get(method) ?? [];
		handlers.push(handler);
		this._notificationHandlers.set(method, handlers);
		return () => {
			const current = this._notificationHandlers.get(method);
			if (current) {
				const index = current.indexOf(handler);
				if (index !== -1) current.splice(index, 1);
			}
		};
	}

	/**
	 * Send a request and wait for response.
	 * @throws RpcError on timeout, cancellation, or remote error.
	 */
	async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		const id = randomUUID();
		const effectiveTimeout = timeoutMs ?? this._defaultTimeoutMs;

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this._pending.delete(id);
				reject({ code: ErrorCode.InternalError, message: `Request timed out: ${method}` });
			}, effectiveTimeout);

			this._pending.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timeout,
				method,
			});

			const request: RpcRequest = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};
			this._transport.send(request);
		});
	}

	/** Send a notification (fire-and-forget, no response expected). */
	notify(method: string, params?: unknown): void {
		const notification: RpcNotification = {
			jsonrpc: "2.0",
			method,
			params,
		};
		this._transport.send(notification);
	}

	/** Cancel a pending request by ID. */
	cancelRequest(id: string | number): void {
		const pending = this._pending.get(id);
		if (pending) {
			clearTimeout(pending.timeout);
			this._pending.delete(id);
			pending.reject({ code: ErrorCode.RequestCancelled, message: `Request cancelled: ${pending.method}` });
		}
	}

	/** Cancel all pending requests. */
	cancelAll(): void {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timeout);
			pending.reject({ code: ErrorCode.RequestCancelled, message: `Request cancelled: ${pending.method}` });
		}
		this._pending.clear();
	}

	/** Close the peer and release resources. */
	close(): void {
		this.cancelAll();
		this._notificationHandlers.clear();
		this._requestHandlers.clear();
		this._unsubTransport?.();
		this._transport.close();
	}

	private _handleMessage(msg: RpcMessage): void {
		if (isResponse(msg)) {
			this._handleResponse(msg);
		} else if (isRequest(msg)) {
			void this._handleRequest(msg);
		} else if (isNotification(msg)) {
			this._handleNotification(msg);
		}
	}

	private _handleResponse(msg: RpcResponse): void {
		const pending = this._pending.get(msg.id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this._pending.delete(msg.id);

		if (msg.error) {
			pending.reject(msg.error);
		} else {
			pending.resolve(msg.result);
		}
	}

	private async _handleRequest(msg: RpcRequest): Promise<void> {
		const handler = this._requestHandlers.get(msg.method);
		if (!handler) {
			this._transport.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCode.MethodNotFound,
					message: `Method not found: ${msg.method}`,
				},
			});
			return;
		}

		try {
			const result = await handler(msg.params);
			this._transport.send({
				jsonrpc: "2.0",
				id: msg.id,
				result,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._transport.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCode.InternalError,
					message,
				},
			});
		}
	}

	private _handleNotification(msg: RpcNotification): void {
		const handlers = this._notificationHandlers.get(msg.method);
		if (!handlers) return;
		for (const handler of handlers) {
			handler(msg.params);
		}
	}
}
