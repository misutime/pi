/** StructuralSearch 类型定义。 */

export interface Position {
	line: number;
	column: number;
}

export interface Range {
	start: Position;
	end: Position;
}

/** 模式匹配结果。 */
export interface PatternMatch {
	filePath: string;
	range: Range;
	text: string;
	/** 模式中具名捕获的变量值，e.g. { NAME: "login", ARGS: "(name, pwd)" } */
	captures: Record<string, string>;
}
