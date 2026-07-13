/**
 * 预定义的代码搜索模式。
 *
 * pattern 语法（与 ast-grep 一致）：
 *   $NAME       → 捕获单个标识符
 *   $$$         → 捕获零个或多个任意节点
 *   $$$NAME     → 多节点捕获 + 命名
 *
 * 按语言族维护独立 pattern 集。
 */

export const PATTERNS = {
	/** JS/TS */
	javascript: {
		functions: ["function $NAME($$$) { $$$ }", "const $NAME = ($$$) => { $$$ }"],
		classes: ["class $NAME { $$$ }"],
		imports: ["import { $$$ } from '$MODULE'", "import $DEFAULT from '$MODULE'"],
		calls: ["$FN($$$ARGS)", "await $FN($$$ARGS)"],
		variables: ["const $NAME = $$$", "let $NAME = $$$", "var $NAME = $$$"],
	},

	/** Python */
	python: {
		functions: ["def $NAME($$$): $$$", "async def $NAME($$$): $$$"],
		classes: ["class $NAME: $$$", "class $NAME($BASE): $$$"],
		imports: ["import $MODULE", "from $MODULE import $$$"],
		calls: ["$FN($$$ARGS)", "self.$FN($$$ARGS)"],
	},

	/** Rust */
	rust: {
		functions: ["fn $NAME($$$) -> $$$ { $$$ }", "fn $NAME($$$) { $$$ }"],
		structs: ["struct $NAME { $$$ }"],
		imports: ["use $$$"],
		calls: ["$FN($$$ARGS)", "self.$FN($$$ARGS)"],
	},
} as const satisfies Record<string, Record<string, string[]>>;

export type Patterns = typeof PATTERNS;
