/**
 * WPILOG binary format parser.
 * Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 * Also handles .hoot (CTRE Phoenix 6) which wraps WPILOG with a variable-length header.
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
  if (t.startsWith("struct:") || t.startsWith("proto:") || t === "raw" || t === "byte[]") return "Raw";
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

// ── Struct descriptor decoder ────────────────────────────────────────────────

interface StructField {
  name: string;
  type: string;
  count: number;
  bitWidth?: number;
}

const STRUCT_SCALAR_SIZES: Record<string, number> = {
  bool: 1, int8: 1, uint8: 1,
  int16: 2, uint16: 2,
  int32: 4, uint32: 4, float: 4,
  int64: 8, uint64: 8, double: 8,
};

function parseStructDescriptor(descriptor: string): StructField[] {
  const fields: StructField[] = [];
  const re = /(\w+)(?:\[(\d+)\])?\s+(\w+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(descriptor)) !== null) {
    const [, type, countStr, name, bitWidthStr] = m;
    fields.push({
      name,
      type: type.toLowerCase(),
      count: countStr ? parseInt(countStr) : 1,
      bitWidth: bitWidthStr ? parseInt(bitWidthStr) : undefined,
    });
  }
  return fields;
}

function decodeStructValue(fields: StructField[], data: Uint8Array, offset: number, length: number): Record<string, number | boolean> | null {
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  const result: Record<string, number | boolean> = {};
  let pos = 0;

  for (const field of fields) {
    const size = STRUCT_SCALAR_SIZES[field.type];
    if (!size) continue;

    const totalSize = size * field.count;
    if (pos + totalSize > length) break;

    if (field.count === 1) {
      let val: number | boolean;
      switch (field.type) {
        case "bool": val = view.getUint8(pos) !== 0; break;
        case "int8": val = view.getInt8(pos); break;
        case "uint8": val = view.getUint8(pos); break;
        case "int16": val = view.getInt16(pos, true); break;
        case "uint16": val = view.getUint16(pos, true); break;
        case "int32": val = view.getInt32(pos, true); break;
        case "uint32": val = view.getUint32(pos, true); break;
        case "float": val = view.getFloat32(pos, true); break;
        case "int64": { const lo = view.getUint32(pos, true); val = view.getInt32(pos + 4, true) * 2 ** 32 + lo; break; }
        case "uint64": { const lo = view.getUint32(pos, true); val = view.getUint32(pos + 4, true) * 2 ** 32 + lo; break; }
        case "double": val = view.getFloat64(pos, true); break;
        default: pos += totalSize; continue;
      }
      result[field.name] = val;
    }
    pos += totalSize;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Find WPILOG magic within a buffer (for HOOT prefix-header files) ─────────
function findWPILOGOffset(bytes: Uint8Array): number {
  const magic = new TextEncoder().encode(WPILOG_MAGIC);
  const scanEnd = Math.min(bytes.length - magic.length, 65536);
  outer: for (let i = 0; i <= scanEnd; i++) {
    for (let j = 0; j < magic.length; j++) {
      if (bytes[i + j] !== magic[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export async function parseWPILOG(
  buffer: ArrayBuffer,
  filename: string,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const bytes = new Uint8Array(buffer);
  const totalBytes = bytes.length;

  let startOffset = 0;
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== WPILOG_MAGIC) {
    const found = findWPILOGOffset(bytes);
    if (found === -1) {
      throw new Error(`Not a valid WPILOG/HOOT file — WPILOG magic bytes not found in ${filename}`);
    }
    startOffset = found;
  }

  const view = new DataView(buffer);
  const version = view.getUint16(startOffset + 7, true);
  if (version < 0x0100 || version > 0x0300) {
    console.warn(`WPILOG version 0x${version.toString(16)} in ${filename} may not be fully supported`);
  }

  const extraLen = view.getUint32(startOffset + 9, true);
  let pos = startOffset + 13 + extraLen;

  const entryMap = new Map<number, EntryInfo>();
  const fields: Record<string, LogField> = {};
  const structDescriptors = new Map<string, StructField[]>();

  let lastYield = Date.now();

  while (pos < bytes.length) {
    if (onProgress && Date.now() - lastYield > 40) {
      onProgress((pos - startOffset) / (totalBytes - startOffset));
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

        const isStruct = typeStr.toLowerCase().startsWith("struct:");
        if (!fields[name]) {
          if (isStruct) {
            let descriptor = "";
            try {
              const meta = JSON.parse(metadata);
              descriptor = meta.schema ?? meta.descriptor ?? "";
            } catch {
              descriptor = metadata;
            }

            if (descriptor) {
              const parsed = parseStructDescriptor(descriptor);
              if (parsed.length > 0) {
                structDescriptors.set(name, parsed);
                for (const sf of parsed) {
                  if (!STRUCT_SCALAR_SIZES[sf.type]) continue;
                  const subKey = `${name}/${sf.name}`;
                  fields[subKey] = {
                    key: subKey,
                    type: sf.type === "bool" ? "Boolean" : "Number",
                    typeStr: sf.type === "double" || sf.type === "float" ? sf.type : "double",
                    entries: [],
                    metadata,
                  };
                }
              }
            }
            fields[name] = {
              key: name,
              type: "Raw",
              typeStr,
              entries: [],
              metadata,
            };
          } else {
            fields[name] = {
              key: name,
              type: typeStrToLoggable(typeStr),
              typeStr,
              entries: [],
              metadata,
            };
          }
        }
      }
    } else {
      const info = entryMap.get(entryId);
      if (info) {
        const field = fields[info.name];
        if (field) {
          try {
            const ts = timestampUs / 1_000_000;
            const value = decodeValue(info.typeStr, bytes, pos, dataSize);
            field.entries.push({ timestamp: ts, value });

            if (info.typeStr.toLowerCase().startsWith("struct:")) {
              const structFields = structDescriptors.get(info.name);
              if (structFields && value instanceof Uint8Array) {
                const decoded = decodeStructValue(structFields, value, 0, value.byteLength);
                if (decoded) {
                  for (const [memberName, memberVal] of Object.entries(decoded)) {
                    const subKey = `${info.name}/${memberName}`;
                    fields[subKey]?.entries.push({ timestamp: ts, value: memberVal as number | boolean });
                  }
                }
              }
            }
          } catch {
            // Skip malformed records
          }
        }
      }
    }

    pos += dataSize;
  }

  onProgress?.(1);
  return buildParsedLog(fields, "WPILOG", filename);
}
