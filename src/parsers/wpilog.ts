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

// ── Struct descriptor decoder ────────────────────────────────────────────

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
  // Match: type[count] name:bitwidth; or type name;
  const re = /(\w+)(?:\[(\d+)\])?\s+(\w+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(descriptor)) !== null) {
    const [, type, countStr, name, bitWidthStr] = m;
    fields.push({
      name,
      type, // keep original case — needed for nested struct type lookups
      count: countStr ? parseInt(countStr) : 1,
      bitWidth: bitWidthStr ? parseInt(bitWidthStr) : undefined,
    });
  }
  return fields;
}

function scalarSize(type: string): number | undefined {
  return STRUCT_SCALAR_SIZES[type.toLowerCase()];
}

// Resolved struct member: flat list of scalar fields with their byte offsets
interface ResolvedMember {
  path: string;      // e.g. "translation/x" for nested structs
  type: string;      // scalar type: "double", "float", "int32", etc.
  byteOffset: number;
}

function resolveStructMembers(
  typeStr: string,
  schemas: Map<string, string>,
  depth = 0
): ResolvedMember[] {
  if (depth > 8) return [];
  const descriptor = schemas.get(typeStr);
  if (!descriptor) return [];

  const result: ResolvedMember[] = [];
  let offset = 0;

  for (const sf of parseStructDescriptor(descriptor)) {
    const sz = scalarSize(sf.type);
    if (sz) {
      for (let i = 0; i < sf.count; i++) {
        const path = sf.count > 1 ? `${sf.name}[${i}]` : sf.name;
        result.push({ path, type: sf.type.toLowerCase(), byteOffset: offset });
        offset += sz;
      }
    } else {
      // Nested struct — preserve original case for schema key lookup
      const nestedTypeStr = `struct:${sf.type}`;
      const nested = resolveStructMembers(nestedTypeStr, schemas, depth + 1);
      const nestedSize = nested.reduce(
        (max, nm) => Math.max(max, nm.byteOffset + (scalarSize(nm.type) ?? 0)),
        0
      );
      for (let i = 0; i < sf.count; i++) {
        const arrayPrefix = sf.count > 1 ? `${sf.name}[${i}]` : sf.name;
        for (const nm of nested) {
          result.push({
            path: `${arrayPrefix}/${nm.path}`,
            type: nm.type,
            byteOffset: offset + nm.byteOffset,
          });
        }
        offset += nestedSize;
      }
    }
  }

  return result;
}

function decodeResolvedStruct(
  members: ResolvedMember[],
  data: Uint8Array,
  dataOffset: number,
  dataLength: number
): Record<string, number | boolean> | null {
  const view = new DataView(data.buffer, data.byteOffset + dataOffset, dataLength);
  const result: Record<string, number | boolean> = {};

  for (const m of members) {
    const size = scalarSize(m.type);
    if (!size || m.byteOffset + size > dataLength) continue;
    let val: number | boolean;
    switch (m.type) {
      case "bool":   val = view.getUint8(m.byteOffset) !== 0; break;
      case "int8":   val = view.getInt8(m.byteOffset); break;
      case "uint8":  val = view.getUint8(m.byteOffset); break;
      case "int16":  val = view.getInt16(m.byteOffset, true); break;
      case "uint16": val = view.getUint16(m.byteOffset, true); break;
      case "int32":  val = view.getInt32(m.byteOffset, true); break;
      case "uint32": val = view.getUint32(m.byteOffset, true); break;
      case "float":  val = view.getFloat32(m.byteOffset, true); break;
      case "double": val = view.getFloat64(m.byteOffset, true); break;
      case "int64": {
        const lo = view.getUint32(m.byteOffset, true);
        val = view.getInt32(m.byteOffset + 4, true) * 2 ** 32 + lo;
        break;
      }
      case "uint64": {
        const lo = view.getUint32(m.byteOffset, true);
        val = view.getUint32(m.byteOffset + 4, true) * 2 ** 32 + lo;
        break;
      }
      default: continue;
    }
    result[m.path] = val;
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

// ── First pass: collect struct schema strings from /.schema/ entries ─────────
function collectStructSchemas(
  bytes: Uint8Array,
  view: DataView,
  startOffset: number
): Map<string, string> {
  const schemas = new Map<string, string>(); // "struct:TypeName" → descriptor
  const schemaEntries = new Map<number, string>(); // entryId → "struct:TypeName"

  const extraLen = view.getUint32(startOffset + 9, true);
  let pos = startOffset + 13 + extraLen;

  while (pos < bytes.length) {
    if (pos + 1 > bytes.length) break;
    const bitfield = view.getUint8(pos++);
    const entryIdLen = (bitfield & 0x03) + 1;
    const sizeLen = ((bitfield >> 2) & 0x03) + 1;
    const timestampLen = ((bitfield >> 4) & 0x07) + 1;
    if (pos + entryIdLen + sizeLen + timestampLen > bytes.length) break;
    const entryId = readVarUint(view, pos, entryIdLen); pos += entryIdLen;
    const dataSize = readVarUint(view, pos, sizeLen); pos += sizeLen;
    pos += timestampLen; // skip timestamp
    if (pos + dataSize > bytes.length) break;

    if (entryId === CONTROL_ENTRY_ID) {
      const ct = view.getUint8(pos);
      if (ct === 0 && pos + 1 + 4 <= pos + dataSize) {
        let cpos = pos + 1;
        const newId = view.getUint32(cpos, true); cpos += 4;
        const nameLen = view.getUint32(cpos, true); cpos += 4;
        if (cpos + nameLen <= pos + dataSize) {
          const name = decodeString(bytes, cpos, nameLen);
          if (name.startsWith("/.schema/struct:")) {
            const typeStr = name.slice("/.schema/".length); // "struct:TypeName"
            schemaEntries.set(newId, typeStr);
          }
        }
      }
    } else {
      const typeStr = schemaEntries.get(entryId);
      if (typeStr && !schemas.has(typeStr)) {
        schemas.set(typeStr, decodeString(bytes, pos, dataSize));
      }
    }

    pos += dataSize;
  }

  return schemas;
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
    // Check for CTRE HOOT proprietary format marker
    const headerStr = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, 32));
    if (headerStr.includes("roboRIO") || headerStr.includes("CANivore") || headerStr.includes("canivore")) {
      throw new Error(
        `${filename} is a CTRE Phoenix .hoot file (proprietary binary format). ` +
        `To view it here, export it to WPILOG or CSV using Phoenix Tuner X: ` +
        `Devices → Log → Export.`
      );
    }
    const found = findWPILOGOffset(bytes);
    if (found === -1) {
      throw new Error(`${filename} is not a valid WPILOG file (magic bytes not found).`);
    }
    startOffset = found;
  }

  const view = new DataView(buffer);
  const version = view.getUint16(startOffset + 7, true);
  if (version < 0x0100 || version > 0x0300) {
    console.warn(`WPILOG version 0x${version.toString(16)} in ${filename} may not be fully supported`);
  }

  // Pass 1: collect struct schemas from /.schema/ entries
  const structSchemas = collectStructSchemas(bytes, view, startOffset);

  const extraLen = view.getUint32(startOffset + 9, true);
  let pos = startOffset + 13 + extraLen;

  const entryMap = new Map<number, EntryInfo>();
  const fields: Record<string, LogField> = {};
  // structName → resolved flat member list
  const resolvedStructs = new Map<string, ResolvedMember[]>();

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

        if (!fields[name]) {
          const isStruct = typeStr.toLowerCase().startsWith("struct:");
          if (isStruct) {
            // Resolve struct members using collected schemas
            const members = resolveStructMembers(typeStr, structSchemas);
            if (members.length > 0) {
              resolvedStructs.set(name, members);
              for (const m of members) {
                const subKey = `${name}/${m.path}`;
                if (!fields[subKey]) {
                  fields[subKey] = {
                    key: subKey,
                    type: m.type === "bool" ? "Boolean" : "Number",
                    typeStr: (m.type === "double" || m.type === "float") ? m.type : "double",
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
          } else if (!name.startsWith("/.schema/")) {
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
      if (info && !info.name.startsWith("/.schema/")) {
        const field = fields[info.name];
        if (field) {
          try {
            const ts = timestampUs / 1_000_000;
            const value = decodeValue(info.typeStr, bytes, pos, dataSize);
            field.entries.push({ timestamp: ts, value });

            if (info.typeStr.toLowerCase().startsWith("struct:")) {
              const members = resolvedStructs.get(info.name);
              if (members && value instanceof Uint8Array) {
                const decoded = decodeResolvedStruct(members, value, 0, value.byteLength);
                if (decoded) {
                  for (const [memberPath, memberVal] of Object.entries(decoded)) {
                    const subKey = `${info.name}/${memberPath}`;
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
