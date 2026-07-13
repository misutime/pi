import type { ChildProcess } from "node:child_process";
import type { RpcMessage } from "./types.ts";

export interface RpcTransport {
	/** Start the transport. For Node IPC this wires the message listener. */
	start(): void;

	/**
	 * Send a message.
	 * @returns true if the message was accepted for delivery; false if the channel is closed or disconnected.
	 */
	send(message: RpcMessage): boolean;

	/** Register a message handler. Returns unsubscribe function. */
	onMessage(handler: (message: RpcMessage) => void): () => void;

	/**
	 * Register a handler for transport-level close (IPC disconnect, stdio EOF, etc).
	 * Called once. Returns unsubscribe function.
	 */
	onClose?(handler: () => void): () => void;

	/**
	 * Register a handler for transport-level errors (broken pipe, process crash, etc).
	 * Returns unsubscribe function.
	 */
	onError?(handler: (err: Error) => void): () => void;

	/** Close the transport. */
	close(): void;
}

/**
 * Node IPC transport using child_process.fork().
 * Uses child.send() / child.on("message") under the hood.
 */
export class NodeIpcTransport implements RpcTransport {
	private _child: ChildProcess;
	private _handlers: Array<(message: RpcMessage) => void> = [];
	private _messageListener: ((msg: unknown) => void) | undefined;
	private _disconnectListener: (() => void) | undefined;
	private _errorListener: ((err: Error) => void) | undefined;
	private _closeHandlers: Array<() => void> = [];
	private _errorHandlers: Array<(err: Error) => void> = [];

	constructor(child: ChildProcess) {
		this._child = child;
	}

	start(): void {
		this._messageListener = (msg: unknown) => {
			if (msg && typeof msg === "object" && "jsonrpc" in msg) {
				for (const handler of this._handlers) {
					handler(msg as RpcMessage);
				}
			}
		};
		this._child.on("message", this._messageListener);

		const onDisconnect = (): void => {
			for (const handler of this._closeHandlers) {
				handler();
			}
		};
		this._disconnectListener = onDisconnect;
		this._child.once("disconnect", onDisconnect);

		const onError = (err: Error): void => {
			for (const handler of this._errorHandlers) {
				handler(err);
			}
		};
		this._errorListener = onError;
		this._child.on("error", onError);
	}

	send(message: RpcMessage): boolean {
		return this._child.send?.(message) ?? false;
	}

	onMessage(handler: (message: RpcMessage) => void): () => void {
		this._handlers.push(handler);
		return () => {
			const index = this._handlers.indexOf(handler);
			if (index !== -1) this._handlers.splice(index, 1);
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

	close(): void {
		if (this._messageListener) {
			this._child.removeListener("message", this._messageListener);
			this._messageListener = undefined;
		}
		if (this._disconnectListener) {
			this._child.removeListener("disconnect", this._disconnectListener);
			this._disconnectListener = undefined;
		}
		if (this._errorListener) {
			this._child.removeListener("error", this._errorListener);
			this._errorListener = undefined;
		}
		this._handlers = [];
		this._closeHandlers = [];
		this._errorHandlers = [];
	}
}

/**
 * Worker-side transport using process.send() / process.on("message").
 */
export class WorkerIpcTransport implements RpcTransport {
	private _handlers: Array<(message: RpcMessage) => void> = [];
	private _messageListener: ((msg: unknown) => void) | undefined;
	private _disconnectListener: (() => void) | undefined;
	private _closeHandlers: Array<() => void> = [];
	private _errorHandlers: Array<(err: Error) => void> = [];

	start(): void {
		this._messageListener = (msg: unknown) => {
			if (msg && typeof msg === "object" && "jsonrpc" in msg) {
				for (const handler of this._handlers) {
					handler(msg as RpcMessage);
				}
			}
		};
		process.on("message", this._messageListener);

		const onDisconnect = (): void => {
			for (const handler of this._closeHandlers) {
				handler();
			}
		};
		this._disconnectListener = onDisconnect;
		process.once("disconnect", onDisconnect);
	}

	send(message: RpcMessage): boolean {
		return process.send?.(message) ?? false;
	}

	onMessage(handler: (message: RpcMessage) => void): () => void {
		this._handlers.push(handler);
		return () => {
			const index = this._handlers.indexOf(handler);
			if (index !== -1) this._handlers.splice(index, 1);
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

	close(): void {
		if (this._messageListener) {
			process.removeListener("message", this._messageListener);
			this._messageListener = undefined;
		}
		if (this._disconnectListener) {
			process.removeListener("disconnect", this._disconnectListener);
			this._disconnectListener = undefined;
		}
		this._handlers = [];
		this._closeHandlers = [];
		this._errorHandlers = [];
	}
}
