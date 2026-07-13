/** JSON-RPC 2.0 message types. */

export interface RpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface RpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: RpcError;
}

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export function isRequest(msg: RpcMessage): msg is RpcRequest {
	return "method" in msg && "id" in msg;
}

export function isResponse(msg: RpcMessage): msg is RpcResponse {
	return "id" in msg && !("method" in msg);
}

export function isNotification(msg: RpcMessage): msg is RpcNotification {
	return "method" in msg && !("id" in msg);
}

/** Error codes per JSON-RPC 2.0 spec. */
export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	ServerErrorStart: -32000,
	ServerErrorEnd: -32099,
	RequestCancelled: -32800,
} as const;
