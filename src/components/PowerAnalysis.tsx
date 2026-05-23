import { useState, useCallback } from "react";
import type { ParsedLog, LogField } from "../types";
import { buildParsedLog } from "../parsers/logUtils";
import { downloadWPILOGAsync } from "../parsers/wpilogWriter";

// Motor IDs and their computed output key
const MOTOR_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21, 12, 13, 14, 15, 16, 17, 20, 22];

// IDs to sum for Total_Wattage (per user specification)
const TOTAL_MOTOR_IDS = [1, 12, 13, 14, 15, 16, 17, 20, 22, 9, 8, 7, 6, 5, 4, 3, 21, 2, 11, 10];

function fieldKeyToIdent(key: string): string {
  return key.replace(/^\//, "").replace(/[^a-zA-Z0-9]/g, "_");
}

function findMotorField(
  logs: ParsedLog[],
  motorId: number,
  suffix: "SupplyCurrent" | "SupplyVoltage",
): LogField | null {
  const targetIdent = `Phoenix6_TalonFX_${motorId}_${suffix}`;
  for (const log of logs) {
    for (const field of Object.values(log.fields)) {
      if (fieldKeyToIdent(field.key) === targetIdent && field.type === "Number") {
        return field;
      }
    }
  }
  // Fallback: regex to handle alternate key formats
  const pattern = new RegExp(`TalonFX[^0-9]0*${motorId}[^0-9].*${suffix}$`, "i");
  for (const log of logs) {
    for (const field of Object.values(log.fields)) {
      if (pattern.test(field.key) && field.type === "Number") {
        return field;
      }
    }
  }
  return null;
}

function findRobotMode(logs: ParsedLog[]): LogField | null {
  for (const log of logs) {
    for (const field of Object.values(log.fields)) {
      if (/robotmode/i.test(field.key)) return field;
    }
  }
  return null;
}

type NumEntry = { timestamp: number; value: number };

function getNumEntries(field: LogField): NumEntry[] {
  return field.entries
    .filter((e) => typeof e.value === "number" && isFinite(e.value as number))
    .map((e) => ({ timestamp: e.timestamp, value: e.value as number }));
}

function computeProduct(aEntries: NumEntry[], bEntries: NumEntry[]): NumEntry[] {
  if (aEntries.length === 0 || bEntries.length === 0) return [];
  const tsSet = new Set<number>();
  aEntries.forEach((e) => tsSet.add(e.timestamp));
  bEntries.forEach((e) => tsSet.add(e.timestamp));
  const timestamps = Array.from(tsSet).sort((a, b) => a - b);

  let iA = 0;
  let iB = 0;
  const result: NumEntry[] = [];
  for (const ts of timestamps) {
    while (iA + 1 < aEntries.length && aEntries[iA + 1].timestamp <= ts) iA++;
    while (iB + 1 < bEntries.length && bEntries[iB + 1].timestamp <= ts) iB++;
    const a = aEntries[iA].timestamp <= ts ? aEntries[iA].value : 0;
    const b = bEntries[iB].timestamp <= ts ? bEntries[iB].value : 0;
    const product = a * b;
    if (isFinite(product)) result.push({ timestamp: ts, value: product });
  }
  return result;
}

function computeSum(allWatts: Map<number, NumEntry[]>, motorIds: number[]): NumEntry[] {
  const tsSet = new Set<number>();
  for (const id of motorIds) {
    (allWatts.get(id) ?? []).forEach((e) => tsSet.add(e.timestamp));
  }
  const timestamps = Array.from(tsSet).sort((a, b) => a - b);
  if (timestamps.length === 0) return [];

  const ptrs = new Map<number, number>(motorIds.map((id) => [id, 0]));
  const result: NumEntry[] = [];
  for (const ts of timestamps) {
    let sum = 0;
    for (const id of motorIds) {
      const arr = allWatts.get(id) ?? [];
      let ptr = ptrs.get(id)!;
      while (ptr + 1 < arr.length && arr[ptr + 1].timestamp <= ts) ptr++;
      ptrs.set(id, ptr);
      const v = arr[ptr]?.timestamp <= ts ? arr[ptr].value : 0;
      sum += v;
    }
    result.push({ timestamp: ts, value: sum });
  }
  return result;
}

interface PowerAnalysisButtonProps {
  logs: ParsedLog[];
}

export function PowerAnalysisButton({ logs }: PowerAnalysisButtonProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");

  const handleClick = useCallback(async () => {
    if (running || logs.length === 0) return;
    setRunning(true);
    setProgress(0);
    setStatusText("Starting…");

    try {
      const allWatts = new Map<number, NumEntry[]>();

      for (let i = 0; i < MOTOR_IDS.length; i++) {
        const id = MOTOR_IDS[i];
        setStatusText(`Motor ${id} (${i + 1}/${MOTOR_IDS.length})`);
        const currField = findMotorField(logs, id, "SupplyCurrent");
        const voltField = findMotorField(logs, id, "SupplyVoltage");
        const watts =
          currField && voltField
            ? computeProduct(getNumEntries(currField), getNumEntries(voltField))
            : [];
        allWatts.set(id, watts);
        setProgress(((i + 1) / MOTOR_IDS.length) * 60);
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      setStatusText("Total Wattage…");
      const totalWatts = computeSum(allWatts, TOTAL_MOTOR_IDS);
      setProgress(65);
      await new Promise<void>((r) => setTimeout(r, 0));

      setStatusText("Building export…");
      const computedFields: Record<string, LogField> = {};

      for (const id of MOTOR_IDS) {
        const entries = allWatts.get(id) ?? [];
        if (entries.length === 0) continue;
        const key = `TalonFX-${id}_Watts`;
        computedFields[key] = { key, type: "Number", typeStr: "double", entries };
      }
      if (totalWatts.length > 0) {
        computedFields["Total_Wattage"] = {
          key: "Total_Wattage",
          type: "Number",
          typeStr: "double",
          entries: totalWatts,
        };
      }
      const robotMode = findRobotMode(logs);
      if (robotMode) {
        computedFields[robotMode.key] = robotMode;
      }
      setProgress(70);
      await new Promise<void>((r) => setTimeout(r, 0));

      const syntheticLog = buildParsedLog(computedFields, "computed", "power_analysis.wpilog");

      setStatusText("Encoding…");
      await downloadWPILOGAsync(
        syntheticLog,
        Object.keys(computedFields),
        (frac) => setProgress(70 + frac * 30),
        "power_analysis.wpilog",
      );

      setProgress(100);
      setStatusText("Done!");
      setTimeout(() => {
        setRunning(false);
        setProgress(0);
        setStatusText("");
      }, 1500);
    } catch (err) {
      setStatusText("Error: " + (err instanceof Error ? err.message : String(err)));
      setTimeout(() => {
        setRunning(false);
        setProgress(0);
        setStatusText("");
      }, 3000);
    }
  }, [logs, running]);

  return (
    <div className="power-analysis-wrap">
      <button
        className={`btn-power ${running ? "running" : ""}`}
        onClick={handleClick}
        disabled={running || logs.length === 0}
        title="Compute TalonFX power fields from all loaded logs and export as WPILOG"
      >
        &#9889;{" "}
        {running ? (statusText || `${Math.round(progress)}%`) : "Power Analysis"}
      </button>
      {running && (
        <div className="power-progress-bar" style={{ width: `${progress}%` }} />
      )}
    </div>
  );
}
