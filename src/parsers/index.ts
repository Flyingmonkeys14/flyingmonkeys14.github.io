import { parseWPILOG } from "./wpilog";
import { parseCSV } from "./csv";
import { parseRLOG } from "./rlog";
import { parseDSLog } from "./dslog";
import type { ParsedLog } from "../types";

export async function parseLogFile(file: File): Promise<ParsedLog> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  // WPILOG variants (including .hoot from CTRE and .revlog from REV)
  if (["wpilog", "hoot", "revlog", "wpilogxz"].includes(ext)) {
    const buf = await file.arrayBuffer();
    return parseWPILOG(buf, file.name);
  }

  if (ext === "csv") {
    const text = await file.text();
    return parseCSV(text, file.name);
  }

  if (ext === "rlog") {
    const buf = await file.arrayBuffer();
    return parseRLOG(buf, file.name);
  }

  if (ext === "dslog" || ext === "dsevents") {
    const buf = await file.arrayBuffer();
    return parseDSLog(buf, file.name);
  }

  // Try WPILOG as fallback for unknown binary files
  if (ext === "log" || ext === "") {
    const buf = await file.arrayBuffer();
    const header = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 7));
    if (header === "WPILOG\0") {
      return parseWPILOG(buf, file.name);
    }
    // Try CSV as text fallback
    try {
      const text = await file.text();
      return parseCSV(text, file.name);
    } catch {
      // ignored
    }
  }

  throw new Error(
    `Unsupported file type: .${ext}\nSupported formats: .wpilog, .hoot, .revlog, .rlog, .dslog, .csv`
  );
}

export { parseWPILOG, parseCSV, parseRLOG, parseDSLog };
