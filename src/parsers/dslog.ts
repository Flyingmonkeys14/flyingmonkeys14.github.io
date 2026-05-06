/**
 * Driver Station Log (.dslog) parser.
 * The .dslog binary format logs robot state at ~50 Hz:
 *   Header: 4-byte version + 4-byte start time (Unix seconds)
 *   Records (17 bytes each at v3):
 *     packet_ms (u32) | lost_packets (u8) | voltage (u8, /256*13) |
 *     status byte | trip_time (u8) | brownout (u8) | user_ds_data (u8) | ...
 */

import type { LogField } from "../types";
import { buildParsedLog } from "./logUtils";
import type { ParsedLog } from "../types";

function addEntry(fields: Record<string, LogField>, key: string, typeStr: string, ts: number, value: number | boolean) {
  if (!fields[key]) {
    fields[key] = {
      key,
      type: typeof value === "boolean" ? "Boolean" : "Number",
      typeStr,
      entries: [],
    };
  }
  fields[key].entries.push({ timestamp: ts, value });
}

export function parseDSLog(buffer: ArrayBuffer, filename: string): ParsedLog {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (bytes.length < 8) throw new Error("DSLog file too short");

  const version = view.getUint32(0, false);
  const startTimeSec = view.getUint32(4, false);

  if (version < 3 || version > 4) {
    console.warn(`DSLog version ${version} may not be fully supported`);
  }

  const fields: Record<string, LogField> = {};
  const RECORD_SIZE = 17;
  let pos = 8;

  while (pos + RECORD_SIZE <= bytes.length) {
    const packetMs = view.getUint32(pos, false);
    const lostPackets = view.getUint8(pos + 4);
    const voltageRaw = view.getUint8(pos + 5);
    const statusByte = view.getUint8(pos + 6);
    const tripTime = view.getUint8(pos + 7);
    const brownout = view.getUint8(pos + 8);

    const timestamp = startTimeSec + packetMs / 1000;

    addEntry(fields, "DS/Voltage", "double", timestamp, (voltageRaw / 256) * 13);
    addEntry(fields, "DS/LostPackets", "int", timestamp, lostPackets);
    addEntry(fields, "DS/TripTime_ms", "int", timestamp, tripTime * 2);
    addEntry(fields, "DS/Brownout", "boolean", timestamp, brownout !== 0);
    addEntry(fields, "DS/RobotEnabled", "boolean", timestamp, (statusByte & 0x04) !== 0);
    addEntry(fields, "DS/Autonomous", "boolean", timestamp, (statusByte & 0x02) !== 0);
    addEntry(fields, "DS/Teleop", "boolean", timestamp, (statusByte & 0x08) !== 0);
    addEntry(fields, "DS/EmergencyStop", "boolean", timestamp, (statusByte & 0x80) !== 0);
    addEntry(fields, "DS/RobotCodeAlive", "boolean", timestamp, (statusByte & 0x20) !== 0);

    pos += RECORD_SIZE;
  }

  if (Object.keys(fields).length === 0) {
    throw new Error("No data found in DSLog file");
  }

  return buildParsedLog(fields, "DS Log", filename);
}
