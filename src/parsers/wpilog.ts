/**
 * WPILOG binary format parser.
 * Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 */

import type { LogField, LogValue } from "../types";
import { buildParsedLog } from "./logUtils";
import type { ParsedLog } from "../types";

const WPILOG_MAGIC = "WPILOG\0";
const CONTROL_ENTRY_ID = 0;

type ProgressCallback = (progress: number) => void;

interface EntryInfo {
  name: string;
  typeStr: string;
  metadata: string;
}

function readVarUint(view: DataView, offset: number, len: number): number {
  let val = 0;
  for (let i = 0; i < len; i++) {
    val |= view.getUint8(offset + i) << (i * 8);
  }
  return val >>> 0;
}

function decodeString(buf: Uint8Array, offset: number, len: number): string {
  return new TextDecoder().decode(buf.subarray(offset, offset + len));
}

export function typeStrToLoggable(typeStr: string): LogField["type"] {
  const t = typeStr.toLowerCase();
  if (t === "boolean") return "Boolean";
  if (t === "int64" || t === "float" || t === "double" || t === "int" || t === "integer") return "Number";
  if (t === "string" || t === "json") return "String";
  if (t === "boolean[]") return "BooleanArray";
  if (t === "int64[]" || t === "float[]" || t === "double[]" || t === "int[]") return "NumberArray";
  if (t === "string[]") return "StringArray";
  if (t === "raw" || t === "byte[]" || t.startsWith("struct:") || t.startsWith("proto:")) return "Raw";
  return "Raw";
}

function decodeValue(
  typeStr: string,
  data: Uint8Array,
  offset: number,
  length: number
): LogValue {
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  const t = typeStr.toLowerCase();

  if (t === "boolean") return view.getUint8(0) !== 0;
  if (t === "double") return view.getFloat64(0, true);
  if (t === "float") return view.getFloat32(0, true);
  if (t === "int64") {
    const lo = view.getUint32(0, true);
    const hi = view.getInt32(4, true);
    return hi * 2 ** 32 + lo;
  }
  if (t === "int" || t === "integer") return view.getInt32(0, true);
  if (t === "string" || t === "json") return decodeString(data, offset, length);

  if (t === "boolean[]") {
    const arr: boolean[] = [];
    for (let i = 0; i < length; i++) arr.push(view.getUint8(i) !== 0);
    return arr;
  }
  if (t === "double[]") {
    const count = Math.floor(length / 8);
    const arr: number[] = [];
    for (let i = 0; i < count; i++) arr.push(view.getFloat64(i * 8, true));
    return arr;
  }
  if (t === "float[]") {
    const count = Math.floor(length / 4);
    const arr: number[] = [];
    for (let i = 0; i < count; i++) arr.push(view.getFloat32(i * 4, true));
    return arr;
  }
  if (t === "int64[]") {
    const count = Math.floor(length / 8);
    const arr: number[] = [];
    for (let i = 0; i < count; i++) {
      const lo = view.getUint32(i * 8, true);
      const hi = view.getInt32(i * 8 + 4, true);
      arr.push(hi * 2 ** 32 + lo);
    }
    return arr;
  }
  if (t === "string[]") {
    const arr: string[] = [];
    let pos = 0;
    while (pos + 4 <= length) {
      const slen = view.getUint32(pos, true);
      pos += 4;
      if (pos + slen > length) break;
      arr.push(decodeString(data, offset + pos, slen));
      pos += slen;
    }
    return arr;
  }

  return data.slice(offset, offset + length);
}

export async function parseWPILOG(
  buffer: ArrayBuffer,
  filename: string,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const totalBytes = bytes.length;

  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== WPILOG_MAGIC) {
    throw new Error("Not a valid WPILOG file (bad magic bytes)");
  }

  const version = view.getUint16(7, true);
  if (version < 0x0100 || version > 0x0200) {
    console.warn(`WPILOG version 0x${version.toString(16)} may not be fully supported`);
  }

  const extraLen = view.getUint32(9, true);
  let pos = 13 + extraLen;

  const entryMap = new Map<number, EntryInfo>();
  const fields: Record<string, LogField> = {};

  let lastYield = Date.now();

  while (pos < bytes.length) {
    // Yield to UI thread every 40ms to allow progress updates
    if (onProgress && Date.now() - lastYield > 40) {
      onProgress(pos / totalBytes);
      await new Promise<void>((r) => setTimeout(r, 0));
      lastYield = Date.now();
    }

    if (pos + 1 > bytes.length) break;

    const bitfield = view.getUint8(pos);
    pos++;

    const entryIdLen = (bitfield & 0x03) + 1;
    const sizeLen = ((bitfield >> 2) & 0x03) + 1;
    const timestampLen = ((bitfield >> 4) & 0x07) + 1;

    if (pos + entryIdLen + sizeLen + timestampLen > bytes.length) break;

    const entryId = readVarUint(view, pos, entryIdLen);
    pos += entryIdLen;
    const dataSize = readVarUint(view, pos, sizeLen);
    pos += sizeLen;
    const timestampUs = readVarUint(view, pos, timestampLen);
    pos += timestampLen;

    if (pos + dataSize > bytes.length) break;

    if (entryId === CONTROL_ENTRY_ID) {
      const controlType = view.getUint8(pos);
      if (controlType === 0) {
        let cpos = pos + 1;
        if (cpos + 4 > pos + dataSize) { pos += dataSize; continue; }
        const newEntryId = view.getUint32(cpos, true);
        cpos += 4;

        const nameLen = view.getUint32(cpos, true);
        cpos += 4;
        const name = decodeString(bytes, cpos, nameLen);
        cpos += nameLen;

        const typeLen = view.getUint32(cpos, true);
        cpos += 4;
        const typeStr = decodeString(bytes, cpos, typeLen);
        cpos += typeLen;

        const metaLen = view.getUint32(cpos, true);
        cpos += 4;
        const metadata = decodeString(bytes, cpos, metaLen);

        entryMap.set(newEntryId, { name, typeStr, metadata });
        if (!fields[name]) {
          fields[name] = {
            key: name,
            type: typeStrToLoggable(typeStr),
            typeStr,
            entries: [],
            metadata,
          };
        }
      }
    } else {
      const info = entryMap.get(entryId);
      if (info) {
        const field = fields[info.name];
        if (field) {
          try {
            const value = decodeValue(info.typeStr, bytes, pos, dataSize);
            field.entries.push({
              timestamp: timestampUs / 1_000_000,
              value,
            });
          } catch {
            // Skip malformed data records
          }
        }
      }
    }

    pos += dataSize;
  }

  onProgress?.(1);
  return buildParsedLog(fields, "WPILOG", filename);
}
