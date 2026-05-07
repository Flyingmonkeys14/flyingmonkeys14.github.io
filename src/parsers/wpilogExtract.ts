/**
 * Lightweight WPILOG utilities that work directly on raw bytes.
 *
 * scanWPILOGFieldNames — O(N) pass over CONTROL_START records only.
 *   Never decodes data values, so it is essentially instant even for huge files.
 *
 * extractWPILOGFields — Two-pass raw-byte extractor.
 *   Pass 1: map field names → entry IDs.
 *   Pass 2: copy header + selected control records + data records verbatim.
 *   No decode/re-encode round-trip, so struct/raw/schema bytes are preserved
 *   exactly and the output is always a valid WPILOG file.
 */

const WPILOG_MAGIC = "WPILOG";
const CONTROL_ENTRY_ID = 0;
const CONTROL_START = 0;
const CONTROL_FINISH = 1;
const CONTROL_SET_METADATA = 2;

const TEXT_DECODER = new TextDecoder("UTF-8");

// ── binary helpers (same logic as wpilog.ts) ─────────────────────────────────

function readVarInt(bytes: Uint8Array, offset: number, len: number): number {
  let lo = 0, hi = 0;
  for (let i = 0; i < Math.min(len, 8); i++) {
    let b = bytes[offset + i];
    if (i === 7) {
      if (b & 0x80) hi = (hi | 0x80000000) | 0;
      b &= 0x7f;
    }
    if (i < 4) lo |= b << (i * 8);
    else        hi |= b << ((i - 4) * 8);
  }
  return (hi >>> 0) * 0x100000000 + (lo >>> 0);
}

function decodeText(bytes: Uint8Array, offset: number, len: number): string {
  return TEXT_DECODER.decode(bytes.subarray(offset, offset + len));
}

interface RecordHeader {
  entryId: number;
  dataSize: number;
  dataOffset: number; // absolute byte offset of payload
}

function readRecordHeader(bytes: Uint8Array, pos: number): [RecordHeader | null, number] {
  if (pos >= bytes.length) return [null, pos];
  const bitfield = bytes[pos++];
  const entryIdLen   = (bitfield & 0x03) + 1;
  const sizeLen      = ((bitfield >> 2) & 0x03) + 1;
  const timestampLen = ((bitfield >> 4) & 0x07) + 1;
  if (pos + entryIdLen + sizeLen + timestampLen > bytes.length) return [null, pos];
  const entryId  = readVarInt(bytes, pos, entryIdLen);  pos += entryIdLen;
  const dataSize = readVarInt(bytes, pos, sizeLen);     pos += sizeLen;
  /* timestamp */ pos += timestampLen;
  if (dataSize < 0 || pos + dataSize > bytes.length) return [null, pos];
  return [{ entryId, dataSize, dataOffset: pos }, pos + dataSize];
}

// ── public types ──────────────────────────────────────────────────────────────

export interface WPILOGFieldInfo {
  name: string;
  typeStr: string;
}

// ── field name scanner ────────────────────────────────────────────────────────

/**
 * Scans CONTROL_START records and returns field names + type strings.
 * Returns null if the buffer is not a valid WPILOG file.
 * Never reads data records, so it runs in microseconds on arbitrarily large files.
 */
export function scanWPILOGFieldNames(buffer: ArrayBuffer): WPILOGFieldInfo[] | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;
  if (decodeText(bytes, 0, 6) !== WPILOG_MAGIC) return null;

  const view = new DataView(buffer);
  const extraLen = view.getUint32(8, true);
  if (12 + extraLen > bytes.length) return null;

  let pos = 12 + extraLen;
  const fields: WPILOGFieldInfo[] = [];
  const seen = new Set<string>();

  while (pos < bytes.length) {
    const [hdr, nextPos] = readRecordHeader(bytes, pos);
    if (!hdr) break;
    pos = nextPos;

    // Skip data records immediately — this is the key performance win
    if (hdr.entryId !== CONTROL_ENTRY_ID) continue;
    if (hdr.dataSize < 13) continue;
    if (bytes[hdr.dataOffset] !== CONTROL_START) continue;

    let cpos = hdr.dataOffset + 1 + 4; // skip ctrl byte + new entryId
    const nameLen = view.getUint32(cpos, true); cpos += 4;
    if (cpos + nameLen > hdr.dataOffset + hdr.dataSize) continue;
    const name = decodeText(bytes, cpos, nameLen); cpos += nameLen;

    const typeLen = view.getUint32(cpos, true); cpos += 4;
    if (cpos + typeLen > hdr.dataOffset + hdr.dataSize) continue;
    const typeStr = decodeText(bytes, cpos, typeLen);

    // Exclude internal schema entries and duplicates
    if (!name.startsWith("/.schema/") && !seen.has(name)) {
      seen.add(name);
      fields.push({ name, typeStr });
    }
  }

  return fields;
}

// ── raw-byte extractor ────────────────────────────────────────────────────────

/**
 * Extracts the selected fields from a WPILOG buffer by copying raw record bytes.
 * Struct schema entries (/.schema/struct:*) are automatically included whenever
 * any selected field has a struct type.
 * The output is a complete, valid WPILOG file.
 */
export function extractWPILOGFields(
  buffer: ArrayBuffer,
  selectedNames: Set<string>
): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  const extraLen = view.getUint32(8, true);
  const recordsStart = 12 + extraLen;

  // ── Pass 1: map names → entry IDs, detect struct fields ──────────────────
  // entryId → field name (including schema entries)
  const entryNames  = new Map<number, string>();
  const selectedIds = new Set<number>();
  let   needSchemas = false; // true if any selected field is a struct type

  let pos = recordsStart;
  while (pos < bytes.length) {
    const [hdr, nextPos] = readRecordHeader(bytes, pos);
    if (!hdr) break;
    pos = nextPos;

    if (hdr.entryId !== CONTROL_ENTRY_ID) continue;
    if (hdr.dataSize < 13) continue;
    if (bytes[hdr.dataOffset] !== CONTROL_START) continue;

    let cpos = hdr.dataOffset + 1;
    const newId  = view.getUint32(cpos, true); cpos += 4;
    const nameLen = view.getUint32(cpos, true); cpos += 4;
    if (cpos + nameLen > hdr.dataOffset + hdr.dataSize) continue;
    const name = decodeText(bytes, cpos, nameLen); cpos += nameLen;

    const typeLen = view.getUint32(cpos, true); cpos += 4;
    if (cpos + typeLen > hdr.dataOffset + hdr.dataSize) continue;
    const typeStr = decodeText(bytes, cpos, typeLen);

    entryNames.set(newId, name);

    if (selectedNames.has(name)) {
      selectedIds.add(newId);
      if (typeStr.toLowerCase().startsWith("struct:")) needSchemas = true;
    }
  }

  // ── Pass 2: copy header + matching records verbatim ───────────────────────
  const chunks: Uint8Array[] = [];

  // Preserve the original file header (magic + version + extra header) exactly
  chunks.push(bytes.subarray(0, recordsStart));

  pos = recordsStart;
  while (pos < bytes.length) {
    const recordStart = pos;
    const [hdr, nextPos] = readRecordHeader(bytes, pos);
    if (!hdr) break;
    pos = nextPos;

    const raw = bytes.subarray(recordStart, nextPos);

    if (hdr.entryId === CONTROL_ENTRY_ID) {
      if (hdr.dataSize < 1) continue;
      const ct = bytes[hdr.dataOffset];

      if (ct === CONTROL_START) {
        let cpos = hdr.dataOffset + 1 + 4; // skip ctrl + new entryId
        const nameLen = view.getUint32(cpos, true); cpos += 4;
        if (cpos + nameLen > hdr.dataOffset + hdr.dataSize) continue;
        const name = decodeText(bytes, cpos, nameLen);

        const include =
          selectedNames.has(name) ||
          (needSchemas && name.startsWith("/.schema/"));

        if (include) chunks.push(raw);
      } else if (ct === CONTROL_FINISH || ct === CONTROL_SET_METADATA) {
        if (hdr.dataSize < 5) continue;
        const targetId = view.getUint32(hdr.dataOffset + 1, true);
        const name     = entryNames.get(targetId) ?? "";
        const include  =
          selectedIds.has(targetId) ||
          (needSchemas && name.startsWith("/.schema/"));
        if (include) chunks.push(raw);
      }
    } else {
      // Data record
      const name = entryNames.get(hdr.entryId) ?? "";
      const include =
        selectedIds.has(hdr.entryId) ||
        (needSchemas && name.startsWith("/.schema/"));
      if (include) chunks.push(raw);
    }
  }

  // Concatenate all chunks into a single ArrayBuffer
  const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
  const output = new Uint8Array(totalSize);
  let off = 0;
  for (const c of chunks) { output.set(c, off); off += c.byteLength; }
  return output.buffer as ArrayBuffer;
}

/** Trigger a browser download of an ArrayBuffer as a .wpilog file. */
export function downloadExtractedWPILOG(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
