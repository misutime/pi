import type { ChildProcess } from "node:child_process";
import type { RpcMessage } from "./types.ts";

export interface RpcTransport {
	/** Start the transport. For Node IPC this wires the message listener. */
	start(): void;

	/** Send a message. */
	send(message: RpcMessage): void;

	/** Register a message handler. Returns unsubscribe function. */
	onMessage(handler: (message: RpcMessage) => void): () => void;

	/** Close the transport. */
	close(): void;
}

/**
 * Node IPC transport using child_process.fork().
 * Uses child.send() / process.on("message") under the hood.
 */
export class NodeIpcTransport implements RpcTransport {
	private _child: ChildProcess;
	private _handlers: Array<(message: RpcMessage) => void> = [];
	private _messageListener: ((msg: unknown) => void) | undefined;

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
	}

	send(message: RpcMessage): void {
		this._child.send?.(message);
	}

	onMessage(handler: (message: RpcMessage) => void): () => void {
		this._handlers.push(handler);
		return () => {
			const index = this._handlers.indexOf(handler);
			if (index !== -1) this._handlers.splice(index, 1);
		};
	}

	close(): void {
		if (this._messageListener) {
			this._child.removeListener("message", this._messageListener);
			this._messageListener = undefined;
		}
		this._handlers = [];
	}
}

/**
 * Worker-side transport using process.send() / process.on("message").
 */
export class WorkerIpcTransport implements RpcTransport {
	private _handlers: Array<(message: RpcMessage) => void> = [];
	private _messageListener: ((msg: unknown) => void) | undefined;

	start(): void {
		this._messageListener = (msg: unknown) => {
			if (msg && typeof msg === "object" && "jsonrpc" in msg) {
				for (const handler of this._handlers) {
					handler(msg as RpcMessage);
				}
			}
		};
		process.on("message", this._messageListener);
	}

	send(message: RpcMessage): void {
		process.send!(message);
	}

	onMessage(handler: (message: RpcMessage) => void): () => void {
		this._handlers.push(handler);
		return () => {
			const index = this._handlers.indexOf(handler);
			if (index !== -1) this._handlers.splice(index, 1);
		};
	}

	close(): void {
		if (this._messageListener) {
			process.removeListener("message", this._messageListener);
			this._messageListener = undefined;
		}
		this._handlers = [];
	}
}
