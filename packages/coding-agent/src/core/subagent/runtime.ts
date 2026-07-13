import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonRpcPeer, NodeIpcTransport } from "../rpc/index.ts";
import type { ProgressParams, RunParams, RunResult, SubAgentConfig } from "./protocol.ts";
import { SubAgentMethods } from "./protocol.ts";

interface RuntimeRecord {
	worker: ChildProcess;
	peer: JsonRpcPeer;
	deferred: {
		resolve: (result: RunResult) => void;
		reject: (error: Error) => void;
	};
	onProgress: (toolName: string) => void;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	abortGraceTimer?: ReturnType<typeof setTimeout>;
	abortListener?: () => void;
	finalized: boolean;
	_cleanup?: () => void;
}

export class SubagentRuntime {
	private _active = new Map<string, RuntimeRecord>();
	private _maxConcurrency: number;
	private _timeoutMs: number;
	private _abortGraceMs: number;
	private _workerPath: string;
	private _execArgv: string[] | undefined;

	constructor(opts: {
		workerPath: string;
		execArgv?: string[];
		maxConcurrency?: number;
		timeoutMs?: number;
		abortGraceMs?: number;
	}) {
		this._workerPath = opts.workerPath;
		this._execArgv = opts.execArgv;
		this._maxConcurrency = opts.maxConcurrency ?? 5;
		this._timeoutMs = opts.timeoutMs ?? 120_000;
		this._abortGraceMs = opts.abortGraceMs ?? 3_000;
	}

	async run(
		task: string,
		config: SubAgentConfig,
		signal: AbortSignal | undefined,
		onProgress: (toolName: string) => void,
	): Promise<RunResult> {
		const agentId = randomUUID();

		if (this._active.size >= this._maxConcurrency) {
			throw new Error(`Subagent concurrency limit (${this._maxConcurrency}) reached`);
		}
		if (signal?.aborted) {
			throw new Error("Aborted before spawn");
		}

		let worker: ChildProcess;
		try {
			worker = fork(this._workerPath, [], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				execArgv: this._execArgv,
			});
		} catch (err) {
			throw new Error(`Failed to fork subagent: ${err instanceof Error ? err.message : String(err)}`);
		}

		const transport = new NodeIpcTransport(worker);
		const peer = new JsonRpcPeer(transport);
		peer.start();

		// Register progress notification handler
		const unsubProgress = peer.onNotification(SubAgentMethods.Progress, (params) => {
			const p = params as ProgressParams;
			onProgress(p.name);
		});

		const record: RuntimeRecord = {
			worker,
			peer,
			deferred: { resolve: undefined!, reject: undefined! },
			onProgress,
			finalized: false,
		};
		this._active.set(agentId, record);

		return new Promise<RunResult>((resolve, reject) => {
			record.deferred = { resolve, reject };

			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const finalize = (resolved: RunResult | null, error: Error | null): void => {
				if (record.finalized) return;
				record.finalized = true;
				cleanup();
				this._active.delete(agentId);
				if (resolved) resolve(resolved);
				else reject(error!);
			};

			const cleanup = (): void => {
				unsubProgress();
				if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
				if (record.abortGraceTimer) clearTimeout(record.abortGraceTimer);
				if (killTimer) clearTimeout(killTimer);
				if (record.abortListener && signal) {
					try {
						signal.removeEventListener("abort", record.abortListener);
					} catch {
						/* ignore */
					}
				}
				peer.close();
			};
			record._cleanup = cleanup;

			const terminate = (): void => {
				if (worker.exitCode !== null || worker.signalCode !== null) return;
				if (killTimer) return; // already terminating
				try {
					worker.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				killTimer = setTimeout(() => {
					if (worker.exitCode !== null || worker.signalCode !== null) return;
					try {
						worker.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, this._abortGraceMs);
			};

			// 1. timeout
			record.timeoutTimer = setTimeout(() => {
				if (!record.finalized) {
					finalize(null, new Error("Subagent timed out"));
					terminate();
				}
			}, this._timeoutMs);

			// 2. abort signal
			if (signal) {
				record.abortListener = () => {
					if (record.abortGraceTimer !== undefined) return;
					if (record.finalized) return;
					peer.notify(SubAgentMethods.Cancel, { id: agentId });
					record.abortGraceTimer = setTimeout(() => {
						if (!record.finalized) {
							finalize(null, new Error("Aborted"));
							terminate();
						}
					}, this._abortGraceMs);
				};
				signal.addEventListener("abort", record.abortListener, { once: true });
				if (signal.aborted) {
					record.abortListener();
				}
			}

			// 3. Send run request via RPC
			const runParams: RunParams = { agentId, task, config };
			peer
				.request<RunResult>(SubAgentMethods.Run, runParams, this._timeoutMs)
				.then((result) => {
					if (!record.finalized) {
						finalize(result, null);
					}
				})
				.catch((err) => {
					if (!record.finalized) {
						const message =
							err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
						finalize(null, new Error(message));
						terminate();
					}
				});

			// 4. worker exit (abnormal)
			worker.on("exit", (code, signal) => {
				if (!record.finalized) {
					finalize(null, new Error(`Worker exited code=${code} signal=${signal}`));
				}
			});

			// 5. worker error event
			worker.on("error", (err) => {
				if (!record.finalized) {
					finalize(null, new Error(`Worker error: ${err.message}`));
					terminate();
				}
			});
		});
	}

	shutdown(): void {
		for (const [, record] of this._active) {
			if (!record.finalized) {
				record.finalized = true;
				record._cleanup?.();
				record.deferred.reject(new Error("Session shutting down"));
			} else {
				record._cleanup?.();
			}
			try {
				record.worker.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
		this._active.clear();
	}
}
