export type LoggableType =
  | "Raw"
  | "Boolean"
  | "Number"
  | "String"
  | "BooleanArray"
  | "NumberArray"
  | "StringArray"
  | "Empty";

export interface LogEntry {
  timestamp: number;
  value: LogValue;
}

export type LogValue =
  | Uint8Array
  | boolean
  | number
  | string
  | boolean[]
  | number[]
  | string[]
  | null;

export interface LogField {
  key: string;
  type: LoggableType;
  typeStr: string;
  entries: LogEntry[];
  /** Metadata / custom schema attached to this field */
  metadata?: string;
}

export interface LogFieldTree {
  fullKey: string | null;
  type?: LoggableType;
  children: Record<string, LogFieldTree>;
}

export interface ParsedLog {
  fields: Record<string, LogField>;
  fieldTree: LogFieldTree;
  startTime: number;
  endTime: number;
  /** Human-readable format name */
  format: string;
  filename: string;
}

export type ParseState =
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "done"; log: ParsedLog }
  | { status: "error"; message: string };
