import { parseWPILOG } from "./wpilog";
import { parseCSV } from "./csv";
import { parseRLOG } from "./rlog";
import { parseDSLog } from "./dslog";
import type { ParsedLog } from "../types";

export type ProgressCallback = (progress: number) => void;

export async function parseLogFile(
  file: File,
  onProgress?: ProgressCallback
): Promise<ParsedLog> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (["wpilog", "hoot", "revlog", "wpilogxz"].includes(ext)) {
    const buf = await file.arrayBuffer();
    return parseWPILOG(buf, file.name, onProgress);
  }

  if (ext === "csv") {
    const text = await file.text();
    return parseCSV(text, file.name, onProgress);
  }

  if (ext === "rlog") {
    const buf = await file.arrayBuffer();
    return parseRLOG(buf, file.name, onProgress);
  }

  if (ext === "dslog" || ext === "dsevents") {
    const buf = await file.arrayBuffer();
    return parseDSLog(buf, file.name, onProgress);
  }

  if (ext === "log" || ext === "") {
    const buf = await file.arrayBuffer();
    const header = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 7));
    if (header === "WPILOG\0") {
      return parseWPILOG(buf, file.name, onProgress);
    }
    try {
      const text = await file.text();
      return parseCSV(text, file.name, onProgress);
    } catch {
      // ignored
    }
  }

  throw new Error(
    `Unsupported file type: .${ext}\nSupported: .wpilog, .hoot, .revlog, .rlog, .dslog, .csv`
  );
}

export { parseWPILOG, parseCSV, parseRLOG, parseDSLog };
