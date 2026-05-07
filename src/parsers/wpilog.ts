/**
 * WPILOG binary format parser.
 * Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 *
 * Header layout (matches AdvantageScope WPILOGDecoder.ts):
 *   Bytes 0-5  : "WPILOG" (6 bytes, no null terminator)
 *   Bytes 6-7  : version (uint16 LE, currently 0x0100)
 *   Bytes 8-11 : extra header length (uint32 LE)
 *   Bytes 12+  : extra header, then records
 *
 * Record layout:
 *   1 byte   : bitfield (bits 0-1 = entry len-1, bits 2-3 = size len-1, bits 4-6 = ts len-1)
 *   N bytes  : entry ID (variable int)
 *   N bytes  : payload size (variable int)
 *   N bytes  : timestamp µs (variable int)
 *   N bytes  : payload
 */

import type { LogField, LogValue } from "../types";
import { buildParsedLog } from "./logUtils";
import type { ParsedLog } from "../types";

const WPILOG_MAGIC = "WPILOG"; // 6 bytes, no null terminator
const CONTROL_ENTRY_ID = 0;
const CONTROL_START = 0;
const CONTROL_FINISH = 1;
const CONTROL_SET_METADATA = 2;

const TEXT_DECODER = new TextDecoder("UTF-8");

type ProgressCallback = (progress: number) => void;

interface EntryInfo {
  name: string;
  typeStr: string;
  metadata: string;
  startTimestamp: number;
}

// ── Binary helpers ────────────────────────────────────────────────────────────

/**
 * Read a little-endian variable-length integer (1–8 bytes).
 * Matches AdvantageScope's readVariableInteger: sign bit is in MSB of 8th byte.
 */
function readVarInt(bytes: Uint8Array, offset: number, len: number): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < Math.min(len, 8); i++) {
    let b = bytes[offset + i];
    if (i === 7) {
      // Sign bit lives in bit 7 of the 8th byte
      if (b & 0x80) hi = (hi | 0x80000000) | 0; // will subtract 2^63 via hi sign
      b &= 0x7f;
    }
    if (i < 4) lo |= b << (i * 8);
    else hi |= b << ((i - 4) * 8);
  }
  return (hi >>> 0) * 0x100000000 + (lo >>> 0);
}

function decodeText(bytes: Uint8Array, offset: number, len: number): string {
  return TEXT_DECODER.decode(bytes.subarray(offset, offset + len));
}

// ── Value decoder (mirrors WPILOGDecoderRecord methods) ──────────────────────

function decodeValue(typeStr: string, data: Uint8Array, offset: number, length: number): LogValue {
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  const t = typeStr.toLowerCase();

  if (t === "boolean") return length >= 1 && view.getUint8(0) !== 0;

  if (t === "double") return length >= 8 ? view.getFloat64(0, true) : 0;
  if (t === "float") return length >= 4 ? view.getFloat32(0, true) : 0;

  if (t === "int64" || t === "int") {
    if (length < 8) return 0;
    return Number(view.getBigInt64(0, true));
  }

  if (t === "string" || t === "json") return decodeText(data, offset, length);

  if (t === "boolean[]") {
    const arr: boolean[] = [];
    for (let i = 0; i < length; i++) arr.push(view.getUint8(i) !== 0);
    return arr;
  }

  if (t === "double[]") {
    if (length % 8 !== 0) return [];
    const arr: number[] = [];
    for (let i = 0; i < length; i += 8) arr.push(view.getFloat64(i, true));
    return arr;
  }

  if (t === "float[]") {
    if (length % 4 !== 0) return [];
    const arr: number[] = [];
    for (let i = 0; i < length; i += 4) arr.push(view.getFloat32(i, true));
    return arr;
  }

  if (t === "int64[]" || t === "int[]") {
    if (length % 8 !== 0) return [];
    const arr: number[] = [];
    for (let i = 0; i < length; i += 8) arr.push(Number(view.getBigInt64(i, true)));
    return arr;
  }

  if (t === "string[]") {
    // Format: [count:uint32][len1:uint32][bytes…][len2:uint32][bytes…]…
    if (length < 4) return [];
    const count = view.getUint32(0, true);
    if (count > (length - 4) / 4) return [];
    const arr: string[] = [];
    let pos = 4;
    for (let i = 0; i < count; i++) {
      if (pos + 4 > length) break;
      const slen = view.getUint32(pos, true);
      pos += 4;
      if (pos + slen > length) break;
      arr.push(decodeText(data, offset + pos, slen));
      pos += slen;
    }
    return arr;
  }

  // Raw / struct / proto — return raw bytes
  return data.slice(offset, offset + length);
}

export function typeStrToLoggable(typeStr: string): LogField["type"] {
  const t = typeStr.toLowerCase();
  if (t === "boolean") return "Boolean";
  if (t === "int64" || t === "float" || t === "double" || t === "int") return "Number";
  if (t === "string" || t === "json") return "String";
  if (t === "boolean[]") return "BooleanArray";
  if (t === "int64[]" || t === "float[]" || t === "double[]" || t === "int[]") return "NumberArray";
  if (t === "string[]") return "StringArray";
  return "Raw";
}

// ── Struct schema / decoding ──────────────────────────────────────────────────

interface StructField {
  name: string;
  type: string; // original case, needed for nested schema lookup
  count: number;
  bitWidth?: number;
}

const STRUCT_SCALAR_SIZES: Record<string, number> = {
  bool: 1, int8: 1, uint8: 1,
  int16: 2, uint16: 2,
  int32: 4, uint32: 4, float: 4,
  int64: 8, uint64: 8, double: 8,
};

function scalarSize(type: string): number | undefined {
  return STRUCT_SCALAR_SIZES[type.toLowerCase()];
}

function parseStructDescriptor(descriptor: string): StructField[] {
  const fields: StructField[] = [];
  const re = /(\w+)(?:\[(\d+)\])?\s+(\w+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(descriptor)) !== null) {
    const [, type, countStr, name, bitWidthStr] = m;
    fields.push({
      name,
      type, // preserve case for nested struct lookups
      count: countStr ? parseInt(countStr) : 1,
      bitWidth: bitWidthStr ? parseInt(bitWidthStr) : undefined,
    });
  }
  return fields;
}

interface ResolvedMember {
  path: string;
  type: string; // lowercase scalar type
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
    if (sz !== undefined) {
      for (let i = 0; i < sf.count; i++) {
        result.push({
          path: sf.count > 1 ? `${sf.name}[${i}]` : sf.name,
          type: sf.type.toLowerCase(),
          byteOffset: offset,
        });
        offset += sz;
      }
    } else {
      const nested = resolveStructMembers(`struct:${sf.type}`, schemas, depth + 1);
      const nestedSize = nested.reduce((mx, m) => Math.max(mx, m.byteOffset + (scalarSize(m.type) ?? 0)), 0);
      for (let i = 0; i < sf.count; i++) {
        const prefix = sf.count > 1 ? `${sf.name}[${i}]` : sf.name;
        for (const m of nested) {
          result.push({ path: `${prefix}/${m.path}`, type: m.type, byteOffset: offset + m.byteOffset });
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
    const sz = scalarSize(m.type);
    if (!sz || m.byteOffset + sz > dataLength) continue;
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
      case "int64":  val = Number(view.getBigInt64(m.byteOffset, true)); break;
      case "uint64": val = Number(view.getBigUint64(m.byteOffset, true)); break;
      default: continue;
    }
    result[m.path] = val;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// ── WPILOG record iteration helper ───────────────────────────────────────────

interface RecordHeader {
  entryId: number;
  dataSize: number;
  timestampUs: number;
  dataOffset: number; // absolute byte offset of payload in `bytes`
}

/**
 * Returns the record header at `pos` and advances pos past the payload.
 * Returns null when there is not enough data remaining.
 */
function readRecordHeader(bytes: Uint8Array, pos: number): [RecordHeader | null, number] {
  if (pos + 1 > bytes.length) return [null, pos];
  const bitfield = bytes[pos++];
  const entryIdLen   = (bitfield & 0x03) + 1;
  const sizeLen      = ((bitfield >> 2) & 0x03) + 1;
  const timestampLen = ((bitfield >> 4) & 0x07) + 1;
  if (pos + entryIdLen + sizeLen + timestampLen > bytes.length) return [null, pos];
  const entryId      = readVarInt(bytes, pos, entryIdLen);      pos += entryIdLen;
  const dataSize     = readVarInt(bytes, pos, sizeLen);         pos += sizeLen;
  const timestampUs  = readVarInt(bytes, pos, timestampLen);    pos += timestampLen;
  if (dataSize < 0 || pos + dataSize > bytes.length) return [null, pos];
  return [{ entryId, dataSize, timestampUs, dataOffset: pos }, pos + dataSize];
}

// ── Pass 1: collect struct schemas from /.schema/struct:* entries ─────────────

function collectStructSchemas(bytes: Uint8Array, startOffset: number): Map<string, string> {
  const schemas = new Map<string, string>();     // "struct:TypeName" → descriptor string
  const schemaEntries = new Map<number, string>(); // entryId → "struct:TypeName"

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extraLen = view.getUint32(startOffset + 8, true); // bytes 8-11 relative to file start
  let pos = startOffset + 12 + extraLen;

  while (pos < bytes.length) {
    const [hdr, nextPos] = readRecordHeader(bytes, pos);
    if (!hdr) break;
    pos = nextPos;

    if (hdr.entryId === CONTROL_ENTRY_ID) {
      if (hdr.dataSize < 1) continue;
      const ct = bytes[hdr.dataOffset];
      if (ct === CONTROL_START && hdr.dataSize >= 13) {
        // Start record: [ctrl:1][entryId:4][nameLen:4][name][typeLen:4][type][metaLen:4][meta]
        let cpos = hdr.dataOffset + 1;
        const newId = view.getUint32(cpos, true); cpos += 4;
        const nameLen = view.getUint32(cpos, true); cpos += 4;
        if (cpos + nameLen > hdr.dataOffset + hdr.dataSize) continue;
        const name = decodeText(bytes, cpos, nameLen);
        if (name.startsWith("/.schema/struct:")) {
          schemaEntries.set(newId, name.slice("/.schema/".length));
        }
      }
    } else {
      const typeStr = schemaEntries.get(hdr.entryId);
      if (typeStr && !schemas.has(typeStr)) {
        schemas.set(typeStr, decodeText(bytes, hdr.dataOffset, hdr.dataSize));
      }
    }
  }

  return schemas;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export async function parseWPILOG(
  buffer: ArrayBuffer,
  filename: string,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // ── HOOT detection ───────────────────────────────────────────────────────
  // AdvantageScope identifies HOOT files by reading the compliancy byte at
  // offset 70 (owletInterface.ts: fs.read(file, buffer, 0, 2, 70, ...)).
  // Compliancy >= 6 means Phoenix 2024+; < 6 means too old for owlet.
  // We also fall back to a header-string check for robustness.
  const isHoot = (() => {
    if (bytes.length > 70) {
      const compliancy = bytes[70];
      // Valid compliancy values are small positive integers (1–20 is a safe range)
      if (compliancy >= 1 && compliancy <= 20) return true;
    }
    const headerStr = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, 64));
    return headerStr.includes("roboRIO") || headerStr.includes("CANivore") || headerStr.includes("canivore");
  })();

  if (isHoot) {
    const compliancy = bytes.length > 70 ? bytes[70] : 0;
    if (compliancy > 0 && compliancy < 6) {
      throw new Error(
        `${filename} is a CTRE Phoenix .hoot file from an older Phoenix version ` +
        `(compliancy ${compliancy}, pre-Phoenix 2024). ` +
        `Hoot logs must be produced by Phoenix 6 (2024 or later) to be converted. ` +
        `Update your robot code to Phoenix 6 to generate a compatible log.`
      );
    }
    throw new Error(
      `${filename} is a CTRE Phoenix .hoot file (compliancy ${compliancy}). ` +
      `This format cannot be decoded directly in a browser. ` +
      `Convert it to WPILOG using CTRE's owlet CLI tool:\n` +
      `  owlet "${filename}" output.wpilog -f wpilog\n` +
      `Download owlet from: https://github.com/CrossTheRoadElec/Phoenix-Releases\n` +
      `Alternatively, export via Phoenix Tuner X: Devices → Log → Export.`
    );
  }

  // Locate WPILOG header (at offset 0 for standard files)
  let startOffset = 0;
  const headerMagic = decodeText(bytes, 0, 6);
  if (headerMagic !== WPILOG_MAGIC) {
    throw new Error(`${filename} is not a valid WPILOG file (magic bytes not found).`);
  }

  // Validate version (bytes 6-7 relative to startOffset)
  const version = view.getUint16(startOffset + 6, true);
  if (version < 0x0100 || version > 0x0300) {
    console.warn(`WPILOG version 0x${version.toString(16)} in ${filename} may not be fully supported`);
  }

  // Pass 1: collect /.schema/struct:* descriptors
  const structSchemas = collectStructSchemas(bytes, startOffset);

  // Pass 2: parse all records
  const extraLen = view.getUint32(startOffset + 8, true);
  let pos = startOffset + 12 + extraLen;
  const endPos = bytes.length;

  const entryMap = new Map<number, EntryInfo>();
  const fields: Record<string, LogField> = {};
  const resolvedStructs = new Map<string, ResolvedMember[]>();

  let lastYield = Date.now();

  while (pos < endPos) {
    if (onProgress && Date.now() - lastYield > 40) {
      onProgress((pos - startOffset) / (endPos - startOffset));
      await new Promise<void>((r) => setTimeout(r, 0));
      lastYield = Date.now();
    }

    const [hdr, nextPos] = readRecordHeader(bytes, pos);
    if (!hdr) break;
    pos = nextPos;

    const { entryId, dataSize, timestampUs, dataOffset } = hdr;
    const ts = timestampUs / 1_000_000;

    if (entryId === CONTROL_ENTRY_ID) {
      if (dataSize < 1) continue;
      const ct = bytes[dataOffset];

      if (ct === CONTROL_START && dataSize >= 13) {
        let cpos = dataOffset + 1;
        const newEntryId = view.getUint32(cpos, true); cpos += 4;

        const nameLen = view.getUint32(cpos, true); cpos += 4;
        if (cpos + nameLen > dataOffset + dataSize) continue;
        const name = decodeText(bytes, cpos, nameLen); cpos += nameLen;

        const typeLen = view.getUint32(cpos, true); cpos += 4;
        if (cpos + typeLen > dataOffset + dataSize) continue;
        const typeStr = decodeText(bytes, cpos, typeLen); cpos += typeLen;

        const metaLen = view.getUint32(cpos, true); cpos += 4;
        const metadata = cpos + metaLen <= dataOffset + dataSize
          ? decodeText(bytes, cpos, metaLen)
          : "";

        entryMap.set(newEntryId, { name, typeStr, metadata, startTimestamp: timestampUs });

        // Skip schema entries and already-registered fields
        if (name.startsWith("/.schema/") || fields[name]) continue;

        const isStruct = typeStr.toLowerCase().startsWith("struct:");
        if (isStruct) {
          const members = resolveStructMembers(typeStr, structSchemas);
          if (members.length > 0) {
            resolvedStructs.set(name, members);
            for (const m of members) {
              const subKey = `${name}/${m.path}`;
              if (!fields[subKey]) {
                fields[subKey] = {
                  key: subKey,
                  type: m.type === "bool" ? "Boolean" : "Number",
                  typeStr: m.type === "double" || m.type === "float" ? m.type : "double",
                  entries: [],
                  metadata,
                };
              }
            }
          }
          // Store raw field so struct bytes are preserved too
          fields[name] = { key: name, type: "Raw", typeStr, entries: [], metadata };
        } else {
          fields[name] = {
            key: name,
            type: typeStrToLoggable(typeStr),
            typeStr,
            entries: [],
            metadata,
          };
        }
      } else if (ct === CONTROL_FINISH && dataSize >= 5) {
        const finishedId = view.getUint32(dataOffset + 1, true);
        const info = entryMap.get(finishedId);
        if (info) {
          // Remove fields that existed for less than 1 second (short-lived, usually transient)
          const lifespan = timestampUs - info.startTimestamp;
          if (lifespan < 1_000_000) {
            const subPrefix = `${info.name}/`;
            delete fields[info.name];
            for (const k of Object.keys(fields)) {
              if (k.startsWith(subPrefix)) delete fields[k];
            }
            resolvedStructs.delete(info.name);
          }
          entryMap.delete(finishedId);
        }
      } else if (ct === CONTROL_SET_METADATA && dataSize >= 9) {
        const targetId = view.getUint32(dataOffset + 1, true);
        const info = entryMap.get(targetId);
        if (info) {
          const metaLen = view.getUint32(dataOffset + 5, true);
          const newMeta = dataOffset + 9 + metaLen <= dataOffset + dataSize
            ? decodeText(bytes, dataOffset + 9, metaLen)
            : "";
          info.metadata = newMeta;
        }
      }
    } else {
      // Data record
      const info = entryMap.get(entryId);
      if (!info || info.name.startsWith("/.schema/")) continue;

      const field = fields[info.name];
      if (!field) continue;

      try {
        const value = decodeValue(info.typeStr, bytes, dataOffset, dataSize);
        field.entries.push({ timestamp: ts, value });

        if (info.typeStr.toLowerCase().startsWith("struct:")) {
          const members = resolvedStructs.get(info.name);
          if (members && value instanceof Uint8Array) {
            const decoded = decodeResolvedStruct(members, value, 0, value.byteLength);
            if (decoded) {
              for (const [memberPath, memberVal] of Object.entries(decoded)) {
                fields[`${info.name}/${memberPath}`]?.entries.push({ timestamp: ts, value: memberVal });
              }
            }
          }
        }
      } catch {
        // skip malformed record
      }
    }
  }

  onProgress?.(1);
  return buildParsedLog(fields, "WPILOG", filename);
}
