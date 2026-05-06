/**
 * RLOG binary format parser (AdvantageKit legacy format).
 */

import type { LogField, LogValue } from "../types";
import { buildParsedLog } from "./logUtils";
import type { ParsedLog } from "../types";

type ProgressCallback = (progress: number) => void;

const TYPE_MAP: Record<number, LogField["type"]> = {
  0: "Empty",
  1: "Boolean",
  2: "Raw",
  3: "Number",
  4: "Number",
  5: "Number",
  6: "String",
  7: "BooleanArray",
  8: "Raw",
  9: "NumberArray",
  10: "NumberArray",
  11: "NumberArray",
  12: "StringArray",
};

const TYPESTR_MAP: Record<number, string> = {
  0: "null",
  1: "boolean",
  2: "byte",
  3: "int",
  4: "float",
  5: "double",
  6: "string",
  7: "boolean[]",
  8: "byte[]",
  9: "int[]",
  10: "float[]",
  11: "double[]",
  12: "string[]",
};

function decodeRlogValue(typeId: number, view: DataView, bytes: Uint8Array, offset: number, end: number): LogValue {
  const len = end - offset;
  switch (typeId) {
    case 0: return null;
    case 1: return view.getUint8(offset) !== 0;
    case 2: return bytes.slice(offset, end);
    case 3: return view.getInt32(offset, false);
    case 4: return view.getFloat32(offset, false);
    case 5: return view.getFloat64(offset, false);
    case 6: return new TextDecoder().decode(bytes.subarray(offset, end));
    case 7: {
      const arr: boolean[] = [];
      for (let i = offset; i < end; i++) arr.push(view.getUint8(i) !== 0);
      return arr;
    }
    case 8: return bytes.slice(offset, end);
    case 9: {
      const arr: number[] = [];
      for (let i = 0; i + 4 <= len; i += 4) arr.push(view.getInt32(offset + i, false));
      return arr;
    }
    case 10: {
      const arr: number[] = [];
      for (let i = 0; i + 4 <= len; i += 4) arr.push(view.getFloat32(offset + i, false));
      return arr;
    }
    case 11: {
      const arr: number[] = [];
      for (let i = 0; i + 8 <= len; i += 8) arr.push(view.getFloat64(offset + i, false));
      return arr;
    }
    case 12: {
      const arr: string[] = [];
      let pos = offset;
      while (pos + 2 <= end) {
        const slen = view.getUint16(pos, false);
        pos += 2;
        arr.push(new TextDecoder().decode(bytes.subarray(pos, pos + slen)));
        pos += slen;
      }
      return arr;
    }
    default: return bytes.slice(offset, end);
  }
}

export async function parseRLOG(
  buffer: ArrayBuffer,
  filename: string,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const totalBytes = bytes.length;
  const fields: Record<string, LogField> = {};

  let pos = 0;
  let lastYield = Date.now();

  while (pos + 4 <= bytes.length) {
    if (onProgress && Date.now() - lastYield > 40) {
      onProgress(pos / totalBytes);
      await new Promise<void>((r) => setTimeout(r, 0));
      lastYield = Date.now();
    }

    const timestampMs = view.getUint32(pos, false);
    pos += 4;

    if (pos + 2 > bytes.length) break;
    const keyLen = view.getUint16(pos, false);
    pos += 2;

    if (pos + keyLen > bytes.length) break;
    const key = new TextDecoder().decode(bytes.subarray(pos, pos + keyLen));
    pos += keyLen;

    if (pos + 1 > bytes.length) break;
    const typeId = view.getUint8(pos);
    pos++;

    if (pos + 2 > bytes.length) break;
    const valueLen = view.getUint16(pos, false);
    pos += 2;

    if (pos + valueLen > bytes.length) break;
    const valueEnd = pos + valueLen;

    const logType = TYPE_MAP[typeId] ?? "Raw";
    if (!fields[key]) {
      fields[key] = {
        key,
        type: logType,
        typeStr: TYPESTR_MAP[typeId] ?? "raw",
        entries: [],
      };
    }

    try {
      const value = decodeRlogValue(typeId, view, bytes, pos, valueEnd);
      if (value !== null) {
        fields[key].entries.push({ timestamp: timestampMs / 1000, value });
      }
    } catch {
      // Skip malformed entries
    }

    pos = valueEnd;
  }

  if (Object.keys(fields).length === 0) {
    throw new Error("No fields found in RLOG file");
  }

  onProgress?.(1);
  return buildParsedLog(fields, "RLOG", filename);
}
