import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ============================================================================
// 类型
// ============================================================================

/** 进程状态。 */
export type ProcessState = "starting" | "running" | "stopping" | "stopped" | "crashed";

/** 进程生命周期策略。 */
export type LifecyclePolicy =
	| {
			/** 任务型：执行完即退出。SubAgent 用 fork()，不经过 ProcessManager。 */
			kind: "task";
	  }
	| {
			/** 会话型：按 workspace+language 启动，空闲超时退出。LSP 用此策略。 */
			kind: "session";
			/** 空闲多少毫秒后自动 shutdown（默认 15 分钟）。 */
			idleTimeoutMs: number;
	  };

/** 进程标识（按 workspace + kind + language 唯一确定一个实例）。 */
export interface ProcessKey {
	workspace: string;
	/** e.g. "lsp" */
	kind: string;
	/** e.g. "typescript", "rust" */
	language?: string;
}

/** spawn 配置。 */
export interface SpawnConfig {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface ExitInfo {
	code: number | null;
	signal: string | null;
}

// ============================================================================
// ManagedProcessHandle
// ============================================================================

export interface ManagedProcessHandle {
	readonly id: string;
	readonly key: ProcessKey;
	readonly state: ProcessState;

	/** 启动进程。幂等：已 running/starting 时 no-op。 */
	start(): Promise<void>;
	/** 停止进程。先 SIGTERM，超时后 SIGKILL。 */
	stop(): Promise<void>;
	/** 停止后重新启动。 */
	restart(): Promise<void>;
	/** 刷新最后访问时间（用于 idle timeout）。 */
	touch(): void;

	/** 底层子进程引用。Transport 从此获取 stdin/stdout。 */
	readonly child: ChildProcess | undefined;

	/** 注册退出事件监听。 */
	onExit(listener: (info: ExitInfo) => void): () => void;
}

// ============================================================================
// ProcessManager
// ============================================================================

export class ProcessManager {
	private _processes = new Map<string, InternalHandle>();

	/**
	 * 按 key 获取或创建进程。
	 *
	 * 流程：
	 * 1. 按 key 查已有进程
	 * 2. 有 → touch() 刷新空闲计时器 → 返回
	 * 3. 无 → 调用 factory 创建新进程 → start() → 注册 → 返回
	 *
	 * @param key 进程标识
	 * @param spawnConfig spawn 配置
	 * @param policy 生命周期策略
	 */
	async getOrCreate(
		key: ProcessKey,
		spawnConfig: SpawnConfig,
		policy: Exclude<LifecyclePolicy, { kind: "task" }>,
	): Promise<ManagedProcessHandle> {
		const keyStr = this._keyToString(key);
		const existing = this._processes.get(keyStr);
		if (existing && existing.state !== "crashed") {
			existing.publicHandle.touch();
			return existing.publicHandle;
		}

		// Remove crashed entry before creating a new one.
		if (existing) {
			this._processes.delete(keyStr);
		}

		const id = randomUUID();
		const handle = new InternalHandle(id, key, spawnConfig, policy, this._processes, keyStr);
		await handle.start();
		this._processes.set(keyStr, handle);
		return handle.publicHandle;
	}

	/**
	 * 主动停止并移除一个进程。
	 */
	async remove(key: ProcessKey): Promise<void> {
		const keyStr = this._keyToString(key);
		const handle = this._processes.get(keyStr);
		if (!handle) return;
		await handle.stop();
		this._processes.delete(keyStr);
	}

	/**
	 * 停止所有进程（Pi 退出时调用）。
	 */
	async shutdownAll(): Promise<void> {
		const handles = [...this._processes.values()];
		this._processes.clear();
		await Promise.all(handles.map((h) => h.stop()));
	}

	/** 当前进程数（测试用）。 */
	get size(): number {
		return this._processes.size;
	}

	private _keyToString(key: ProcessKey): string {
		return `${key.workspace}::${key.kind}::${key.language ?? ""}`;
	}
}

// ============================================================================
// InternalHandle
// ============================================================================

class InternalHandle {
	private _state: ProcessState = "stopped";
	private _child: ChildProcess | undefined;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;
	private _exitListeners: Array<(info: ExitInfo) => void> = [];
	private _publicHandle: ManagedProcessHandle;
	private _policy: LifecyclePolicy;
	private _spawnConfig: SpawnConfig;
	private _managerProcesses: Map<string, InternalHandle>;
	private _keyStr: string;
	private _key: ProcessKey;

	constructor(
		id: string,
		key: ProcessKey,
		spawnConfig: SpawnConfig,
		policy: LifecyclePolicy,
		managerProcesses: Map<string, InternalHandle>,
		keyStr: string,
	) {
		this._key = key;
		this._spawnConfig = spawnConfig;
		this._policy = policy;
		this._managerProcesses = managerProcesses;
		this._keyStr = keyStr;

		const self = this;
		this._publicHandle = {
			get id() {
				return id;
			},
			get key() {
				return self._key;
			},
			get state() {
				return self._state;
			},
			get child() {
				return self._child;
			},
			start: () => self.start(),
			stop: () => self.stop(),
			restart: () => self.restart(),
			touch: () => self.touch(),
			onExit: (listener) => {
				self._exitListeners.push(listener);
				return () => {
					const idx = self._exitListeners.indexOf(listener);
					if (idx !== -1) self._exitListeners.splice(idx, 1);
				};
			},
		};
	}

	get publicHandle(): ManagedProcessHandle {
		return this._publicHandle;
	}

	get state(): ProcessState {
		return this._state;
	}

	async start(): Promise<void> {
		if (this._state === "running" || this._state === "starting") return;

		this._state = "starting";

		const args = this._spawnConfig.args ?? [];
		try {
			this._child = spawn(this._spawnConfig.command, args, {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this._spawnConfig.cwd,
				env: { ...process.env, ...this._spawnConfig.env },
			});
		} catch (err) {
			this._state = "crashed";
			const msg = err instanceof Error ? err.message : String(err);
			for (const listener of this._exitListeners) {
				listener({ code: null, signal: null });
			}
			throw new Error(`Failed to spawn ${this._spawnConfig.command}: ${msg}`);
		}

		this._child.on("exit", (code, signal) => {
			if (this._state === "stopping") {
				this._state = "stopped";
			} else {
				this._state = "crashed";
			}
			const info: ExitInfo = { code, signal };
			for (const listener of this._exitListeners) {
				listener(info);
			}
			this._clearIdleTimer();
		});

		this._child.on("error", (_err) => {
			// ENOENT or other spawn failure — may not be followed by exit.
			if (this._state !== "stopping") {
				this._state = "crashed";
			}
			const info: ExitInfo = { code: null, signal: null };
			for (const listener of this._exitListeners) {
				listener(info);
			}
			this._clearIdleTimer();
		});

		this._state = "running";
		this._startIdleTimerIfSession();
	}

	async stop(): Promise<void> {
		if (this._state === "stopped" || this._state === "stopping") return;

		this._state = "stopping";
		this._clearIdleTimer();

		const child = this._child;
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}

			// Wait up to 5 seconds for graceful exit, then force SIGKILL.
			await new Promise<void>((resolve) => {
				const forceKill = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					resolve();
				}, 5000);

				child.once("exit", () => {
					clearTimeout(forceKill);
					resolve();
				});
			});
		}

		this._state = "stopped";
		this._child = undefined;
		this._managerProcesses.delete(this._keyStr);
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	touch(): void {
		this._clearIdleTimer();
		this._startIdleTimerIfSession();
	}

	private _startIdleTimerIfSession(): void {
		if (this._policy.kind !== "session") return;
		const timeoutMs = this._policy.idleTimeoutMs;
		if (timeoutMs <= 0) return;

		this._idleTimer = setTimeout(() => {
			void this.stop();
		}, timeoutMs);
	}

	private _clearIdleTimer(): void {
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
	}
}
