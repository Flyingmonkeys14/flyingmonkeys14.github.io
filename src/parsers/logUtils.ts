import type { LogField, LogFieldTree, ParsedLog, LogValue } from "../types";

export function buildFieldTree(fields: Record<string, LogField>): LogFieldTree {
  const root: LogFieldTree = { fullKey: null, children: {} };
  for (const key of Object.keys(fields)) {
    const parts = key.replace(/^\//, "").split("/");
    let node = root;
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      path = path ? `${path}/${part}` : part;
      if (!node.children[part]) {
        node.children[part] = { fullKey: null, children: {} };
      }
      node = node.children[part];
      if (i === parts.length - 1) {
        node.fullKey = key;
        node.type = fields[key].type;
      }
    }
  }
  return root;
}

export function buildParsedLog(
  fields: Record<string, LogField>,
  format: string,
  filename: string
): ParsedLog {
  let startTime = Infinity;
  let endTime = -Infinity;
  for (const field of Object.values(fields)) {
    for (const entry of field.entries) {
      if (entry.timestamp < startTime) startTime = entry.timestamp;
      if (entry.timestamp > endTime) endTime = entry.timestamp;
    }
  }
  if (!isFinite(startTime)) startTime = 0;
  if (!isFinite(endTime)) endTime = 0;

  return {
    fields,
    fieldTree: buildFieldTree(fields),
    startTime,
    endTime,
    format,
    filename,
  };
}

export function formatValue(value: LogValue): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
  }
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toString();
    return value.toPrecision(7).replace(/\.?0+$/, "");
  }
  return String(value);
}

export function getValueAtTime(field: LogField, time: number): LogValue {
  if (field.entries.length === 0) return null;
  let lo = 0;
  let hi = field.entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (field.entries[mid].timestamp <= time) lo = mid;
    else hi = mid - 1;
  }
  return field.entries[lo].timestamp <= time ? field.entries[lo].value : null;
}
