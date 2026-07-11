/**
 * SubagentAbortScope — 管理子代理的 abort 生命周期。
 *
 * 融合外部 AbortSignal 和超时，提供：
 * - first-wins 原因跟踪
 * - childSession 自动中止绑定
 * - 资源清理和终止消息格式化
 */

// ============================================================================
// Types
// ============================================================================

/** Abort 原因类型 */
export type AbortReason =
	| { type: "external" }
	| { type: "timeout"; ms: number };

// ============================================================================
// SubagentAbortScope
// ============================================================================

export class SubagentAbortScope {
	private controller = new AbortController();
	private reason_: AbortReason | null = null;
	private timeoutId: ReturnType<typeof setTimeout> | undefined;
	private externalListener: (() => void) | undefined;
	private externalSignal: AbortSignal | undefined;
	private _session: { abort(): Promise<void> } | undefined;

	constructor(externalSignal?: AbortSignal, timeoutMs?: number) {
		this.externalSignal = externalSignal;

		// Wire external signal
		if (externalSignal) {
			if (externalSignal.aborted) {
				this.reason_ = { type: "external" };
				this.controller.abort();
			} else {
				const listener = () => {
					if (!this.reason_) {
						this.reason_ = { type: "external" };
					}
					this.controller.abort();
				};
				this.externalListener = listener;
				externalSignal.addEventListener("abort", listener, { once: true });
			}
		}

		// Wire timeout（first-wins：只有 reason_ 尚未设置时才写入）
		if (timeoutMs !== undefined) {
			this.timeoutId = setTimeout(() => {
				if (!this.reason_) {
					this.reason_ = { type: "timeout", ms: timeoutMs };
				}
				this.controller.abort();
			}, timeoutMs);
		}
	}

	/** 内部信号，用于 setSession 绑定和 scope.aborted 检查。 */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** 是否已中止 */
	get aborted(): boolean {
		return this.controller.signal.aborted;
	}

	/** first-wins 中止原因。null = 未中止。 */
	get reason(): AbortReason | null {
		return this.reason_;
	}

	/**
	 * 绑定子 session。
	 * abort 时自动调用 session.abort()；若已 abort 则立即调用。
	 */
	setSession(session: { abort(): Promise<void> }): void {
		this._session = session;
		if (this.aborted) {
			session.abort()?.catch(() => {});
		} else {
			this.controller.signal.addEventListener(
				"abort",
				() => session.abort()?.catch(() => {}),
				{ once: true },
			);
		}
	}

	/** 格式化终止消息 */
	terminationMessage(assistantText?: string): string {
		let reasonStr: string;
		if (!this.reason_) {
			reasonStr = "任务被中断";
		} else if (this.reason_.type === "external") {
			reasonStr = "任务被中断";
		} else {
			reasonStr = `超时（${this.reason_.ms}ms）`;
		}
		return `本次 agent 执行终止，返回内容: ${reasonStr}${assistantText ? "。最后输出: " + assistantText : ""}`;
	}

	/** 清理定时器和事件监听器 */
	dispose(): void {
		if (this.timeoutId !== undefined) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		if (this.externalListener && this.externalSignal) {
			this.externalSignal.removeEventListener("abort", this.externalListener);
			this.externalListener = undefined;
		}
		this._session = undefined;
	}
}
