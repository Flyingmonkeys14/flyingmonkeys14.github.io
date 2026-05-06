/**
 * CSV log parser supporting two layouts:
 *   1. Three-column: Timestamp, Key, Value
 *   2. Multi-column: First column = Timestamp, remaining columns = field keys (header row)
 */

import type { LogField, LogValue } from "../types";
import { buildParsedLog } from "./logUtils";
import type { ParsedLog } from "../types";

type ProgressCallback = (progress: number) => void;

const NULL_LIKE = new Set(["", "null", "NULL", "N/A", "n/a", "NA", "na", "NaN", "nan", "undefined"]);

function inferType(values: string[]): LogField["type"] {
  const sample = values.filter((v) => !NULL_LIKE.has(v.trim())).slice(0, 100);
  if (sample.length === 0) return "Number";
  if (sample.every((v) => v.toLowerCase() === "true" || v.toLowerCase() === "false")) return "Boolean";
  if (sample.every((v) => v !== "" && !isNaN(Number(v)))) return "Number";
  return "String";
}

function parseValue(raw: string, type: LogField["type"]): LogValue {
  const trimmed = raw.trim();

  if (type === "Number") {
    if (NULL_LIKE.has(trimmed)) return 0;
    const n = Number(trimmed);
    return isNaN(n) ? 0 : n;
  }

  if (trimmed === "") return null;

  if (type === "Boolean") return trimmed.toLowerCase() === "true";

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    const parts = inner.split(/[,;]/).map((s) => s.trim());
    if (parts.every((p) => p.toLowerCase() === "true" || p.toLowerCase() === "false")) {
      return parts.map((p) => p.toLowerCase() === "true");
    }
    const nums = parts.map(Number);
    if (nums.every((n) => !isNaN(n))) return nums;
    return parts;
  }

  return trimmed;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let cur = "";
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

const YIELD_EVERY = 500;

export async function parseCSV(
  text: string,
  filename: string,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV file is too short");

  const header = splitCSVLine(lines[0]);
  const fields: Record<string, LogField> = {};

  const firstData = splitCSVLine(lines[1]);
  const isThreeCol =
    header.length === 3 &&
    header.map((h) => h.trim().toLowerCase()).join(",").match(/timestamp.*key.*value/i) !== null;

  const isKeyValueFormat =
    !isThreeCol &&
    header.length >= 2 &&
    firstData.length >= 2 &&
    !isNaN(Number(firstData[0])) &&
    isNaN(Number(firstData[1]));

  if (isThreeCol || isKeyValueFormat) {
    const rawValues: Record<string, string[]> = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCSVLine(lines[i]);
      if (cols.length < 3) continue;
      const key = cols[1].trim();
      if (!rawValues[key]) rawValues[key] = [];
      rawValues[key].push(cols[2].trim());
    }

    for (const key of Object.keys(rawValues)) {
      const t = inferType(rawValues[key]);
      fields[key] = {
        key,
        type: t,
        typeStr: t === "Number" ? "double" : t.toLowerCase(),
        entries: [],
      };
    }

    for (let i = 1; i < lines.length; i++) {
      if (i % YIELD_EVERY === 0 && onProgress) {
        onProgress(i / lines.length);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const cols = splitCSVLine(lines[i]);
      if (cols.length < 3) continue;
      const ts = Number(cols[0].trim());
      if (isNaN(ts)) continue;
      const key = cols[1].trim();
      const field = fields[key];
      if (!field) continue;
      const value = parseValue(cols[2], field.type);
      if (value !== null) {
        field.entries.push({ timestamp: ts, value });
      }
    }
  } else {
    const keys = header.slice(1).map((h) => h.trim());
    const rawValues: Record<string, string[]> = {};
    for (const k of keys) rawValues[k] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCSVLine(lines[i]);
      for (let j = 0; j < keys.length; j++) {
        rawValues[keys[j]].push((cols[j + 1] ?? "").trim());
      }
    }

    for (const key of keys) {
      const t = inferType(rawValues[key]);
      fields[key] = {
        key,
        type: t,
        typeStr: t === "Number" ? "double" : t.toLowerCase(),
        entries: [],
      };
    }

    for (let i = 1; i < lines.length; i++) {
      if (i % YIELD_EVERY === 0 && onProgress) {
        onProgress(i / lines.length);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const cols = splitCSVLine(lines[i]);
      const ts = Number(cols[0]?.trim());
      if (isNaN(ts)) continue;
      for (let j = 0; j < keys.length; j++) {
        const field = fields[keys[j]];
        const raw = cols[j + 1] ?? "";
        const value = parseValue(raw, field.type);
        if (value !== null) {
          field.entries.push({ timestamp: ts, value });
        }
      }
    }
  }

  if (Object.keys(fields).length === 0) {
    throw new Error("No fields found in CSV file");
  }

  onProgress?.(1);
  return buildParsedLog(fields, "CSV", filename);
}
