/**
 * WPILOG binary encoder.
 * Writes a valid WPILOG v1.0 file from a subset of fields.
 *
 * Wire layout chosen for simplicity:
 *   entry_id: 1 byte  -> bitfield bits 0-1 = 0
 *   data_size: 4 bytes -> bitfield bits 2-3 = 3
 *   timestamp: 4 bytes -> bitfield bits 4-6 = 3
 *   bitfield = 0b0_011_11_00 = 0x3C
 */

import type { ParsedLog, LogValue } from "../types";

const MAGIC = "WPILOG\0";
const VERSION = 0x0100; // v1.0
const BITFIELD = 0x3c;  // 1-byte id, 4-byte size, 4-byte timestamp
const MAX_TIMESTAMP_US = 0xffffffff; // ~71 min; clamp if exceeded

// -- helpers --

class DynamicBuffer {
  private chunks: Uint8Array[] = [];
  private _size = 0;

  get size() { return this._size; }

  append(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this._size += chunk.byteLength;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this._size);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
}

function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

function f32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return b;
}

function f64le(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}

function i32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
}

function i64le(v: number): Uint8Array {
  const lo = v >>> 0;
  const hi = Math.floor(v / 2 ** 32);
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, lo, true);
  dv.setInt32(4, hi, true);
  return b;
}

function encStr(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// -- typeStr normalizer --
function normalizeTypeStr(typeStr: string, logType: string): string {
  const t = typeStr.toLowerCase();
  const canonical = ["boolean", "double", "float", "int64", "int", "integer", "string", "json",
    "boolean[]", "double[]", "float[]", "int64[]", "int[]", "string[]"];
  if (canonical.includes(t)) return t;
  if (t === "number") return "double";
  if (t === "bool") return "boolean";
  if (t === "numberarray") return "double[]";
  if (t === "booleanarray") return "boolean[]";
  if (t === "stringarray") return "string[]";
  if (logType === "Number") return "double";
  if (logType === "Boolean") return "boolean";
  if (logType === "String") return "string";
  if (logType === "NumberArray") return "double[]";
  if (logType === "BooleanArray") return "boolean[]";
  if (logType === "StringArray") return "string[]";
  return typeStr;
}

// -- value encoder --

function encodeValue(typeStr: string, value: LogValue): Uint8Array | null {
  if (value === null) return null;
  const t = typeStr.toLowerCase();

  if (t === "boolean") return u8(value ? 1 : 0);
  if (t === "double") return f64le(value as number);
  if (t === "float") return f32le(value as number);
  if (t === "int64") return i64le(value as number);
  if (t === "int" || t === "integer") return i32le(value as number);
  if (t === "string" || t === "json") return encStr(value as string);

  if (t === "boolean[]") {
    const arr = value as boolean[];
    return new Uint8Array(arr.map((b) => (b ? 1 : 0)));
  }
  if (t === "double[]") {
    const arr = value as number[];
    const out = new Uint8Array(arr.length * 8);
    const dv = new DataView(out.buffer);
    arr.forEach((n, i) => dv.setFloat64(i * 8, n, true));
    return out;
  }
  if (t === "float[]") {
    const arr = value as number[];
    const out = new Uint8Array(arr.length * 4);
    const dv = new DataView(out.buffer);
    arr.forEach((n, i) => dv.setFloat32(i * 4, n, true));
    return out;
  }
  if (t === "int64[]") {
    const arr = value as number[];
    const out = new Uint8Array(arr.length * 8);
    const dv = new DataView(out.buffer);
    arr.forEach((n, i) => {
      dv.setUint32(i * 8, n >>> 0, true);
      dv.setInt32(i * 8 + 4, Math.floor(n / 2 ** 32), true);
    });
    return out;
  }
  if (t === "int[]") {
    const arr = value as number[];
    const out = new Uint8Array(arr.length * 4);
    const dv = new DataView(out.buffer);
    arr.forEach((n, i) => dv.setInt32(i * 4, n, true));
    return out;
  }
  if (t === "string[]") {
    const arr = value as string[];
    const parts = arr.map((s) => {
      const enc = encStr(s);
      const chunk = new Uint8Array(4 + enc.byteLength);
      new DataView(chunk.buffer).setUint32(0, enc.byteLength, true);
      chunk.set(enc, 4);
      return chunk;
    });
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  if (value instanceof Uint8Array) return value;
  if (typeof value === "number") return f64le(value);

  return null;
}

// -- record builders --

function writeRecord(buf: DynamicBuffer, entryId: number, timestampUs: number, data: Uint8Array) {
  const clampedTs = Math.min(Math.round(timestampUs), MAX_TIMESTAMP_US);
  buf.append(u8(BITFIELD));
  buf.append(u8(entryId));
  buf.append(u32le(data.byteLength));
  buf.append(u32le(clampedTs));
  buf.append(data);
}

function buildStartRecord(entryId: number, name: string, typeStr: string, metadata: string): Uint8Array {
  const nameBuf = encStr(name);
  const typeBuf = encStr(typeStr);
  const metaBuf = encStr(metadata);
  const total = 1 + 4 + 4 + nameBuf.byteLength + 4 + typeBuf.byteLength + 4 + metaBuf.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  out[off++] = 0;
  dv.setUint32(off, entryId, true); off += 4;
  dv.setUint32(off, nameBuf.byteLength, true); off += 4;
  out.set(nameBuf, off); off += nameBuf.byteLength;
  dv.setUint32(off, typeBuf.byteLength, true); off += 4;
  out.set(typeBuf, off); off += typeBuf.byteLength;
  dv.setUint32(off, metaBuf.byteLength, true); off += 4;
  out.set(metaBuf, off);
  return out;
}

// -- public API --

export function encodeWPILOG(log: ParsedLog, selectedKeys: string[]): ArrayBuffer {
  const buf = new DynamicBuffer();

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  header.set(encStr(MAGIC));
  hv.setUint16(7, VERSION, true);
  hv.setUint32(9, 0, true);
  buf.append(header);

  const fieldKeys = selectedKeys.filter((k) => log.fields[k]);
  const idMap = new Map<string, number>();
  fieldKeys.forEach((key, i) => idMap.set(key, i + 1));

  let originSec = Infinity;
  for (const key of fieldKeys) {
    const f = log.fields[key];
    if (f.entries.length > 0) {
      originSec = Math.min(originSec, f.entries[0].timestamp);
    }
  }
  if (!isFinite(originSec)) originSec = 0;

  for (const key of fieldKeys) {
    const field = log.fields[key];
    const entryId = idMap.get(key)!;
    const norm = normalizeTypeStr(field.typeStr, field.type);
    const startData = buildStartRecord(entryId, key, norm, field.metadata ?? "");
    writeRecord(buf, 0, 0, startData);
  }

  type DataEvent = { timestampUs: number; entryId: number; data: Uint8Array };
  const events: DataEvent[] = [];

  for (const key of fieldKeys) {
    const field = log.fields[key];
    const entryId = idMap.get(key)!;
    const norm = normalizeTypeStr(field.typeStr, field.type);
    for (const entry of field.entries) {
      const data = encodeValue(norm, entry.value);
      if (!data) continue;
      const timestampUs = Math.round((entry.timestamp - originSec) * 1_000_000);
      events.push({ timestampUs, entryId, data });
    }
  }

  events.sort((a, b) => a.timestampUs - b.timestampUs);

  for (const ev of events) {
    writeRecord(buf, ev.entryId, ev.timestampUs, ev.data);
  }

  return buf.toUint8Array().buffer as ArrayBuffer;
}

export function downloadWPILOG(log: ParsedLog, selectedKeys: string[], outputName?: string) {
  const buffer = encodeWPILOG(log, selectedKeys);
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = outputName ?? deriveOutputName(log.filename, selectedKeys);
  a.click();
  URL.revokeObjectURL(url);
}

function deriveOutputName(originalFilename: string, selectedKeys: string[]): string {
  const base = originalFilename.replace(/\.[^.]+$/, "");
  const suffix = selectedKeys.length === 1
    ? "_" + selectedKeys[0].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30)
    : `_${selectedKeys.length}fields`;
  return `${base}${suffix}.wpilog`;
}
