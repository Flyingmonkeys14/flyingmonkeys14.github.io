import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { ParsedLog, LogField } from "./types";
import { parseLogFile } from "./parsers/index";
import { buildFieldTree } from "./parsers/logUtils";
import { scanWPILOGFieldNames } from "./parsers/wpilogExtract";
import { PasswordGate, isAuthenticated } from "./components/PasswordGate";
import { FieldTree } from "./components/FieldTree";
import { TimeChart, ValueTable } from "./components/TimeChart";
import type { LogSelection } from "./components/TimeChart";
import { TimeSlider } from "./components/TimeSlider";
import { StatsTable } from "./components/StatsTable";
import { CalculatedFields } from "./components/CalculatedFields";
import { WPILOGExtractModal } from "./components/WPILOGExtractModal";
import type { ExtractSourceInfo } from "./components/WPILOGExtractModal";
import { ExportModal } from "./components/ExportModal";
import { PowerAnalysisButton } from "./components/PowerAnalysis";

type Tab = "chart" | "table" | "stats";

interface LogEntry {
  filename: string;
  log: ParsedLog | null;
  error: string | null;
  loading: boolean;
  progress: number;
  loadStartMs: number;
  source: "manifest" | "upload";
}

function formatEta(entry: LogEntry): string {
  if (entry.progress <= 0.01) return "";
  const elapsed = Date.now() - entry.loadStartMs;
  const total = elapsed / entry.progress;
  const remaining = Math.max(0, total - elapsed);
  if (remaining < 1000) return "< 1s";
  return `~${Math.ceil(remaining / 1000)}s`;
}

async function fetchLogFile(filename: string): Promise<File> {
  const url = `./logs/${filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return new File([blob], filename);
}

// Enabled-field candidates in priority order, matching AdvantageScope's getEnabledKey()
const ENABLED_CANDIDATES: { key: string; getValue: (v: unknown) => boolean }[] = [
  { key: "/DriverStation/Enabled",                  getValue: (v) => Boolean(v) },
  { key: "NT:/AdvantageKit/DriverStation/Enabled",  getValue: (v) => Boolean(v) },
  { key: "DS:enabled",                              getValue: (v) => Boolean(v) },
  { key: "/DSLog/Status/DSDisabled",                getValue: (v) => !v },
  { key: "RobotEnable",                             getValue: (v) => Boolean(v) },
  { key: "NT:/FMSInfo/FMSControlData",              getValue: (v) => (v as number) % 2 === 1 },
  { key: "RUNNING",                                 getValue: (v) => Boolean(v) },
];

function findEnabledRange(log: ParsedLog): [number, number] | null {
  const candidate = ENABLED_CANDIDATES.find((c) => log.fields[c.key]);
  if (!candidate) return null;
  const { key, getValue } = candidate;
  const entries = log.fields[key].entries;
  if (entries.length === 0) return null;

  const firstEnableIdx = entries.findIndex((e) => getValue(e.value));
  if (firstEnableIdx < 0) return null;

  // Find the last disable after the first enable (only if the log ends disabled)
  let lastDisableIdx = -1;
  if (!getValue(entries[entries.length - 1].value)) {
    for (let i = entries.length - 1; i >= firstEnableIdx; i--) {
      if (!getValue(entries[i].value)) { lastDisableIdx = i; break; }
    }
  }

  const trimStart = entries[firstEnableIdx].timestamp;
  const trimEnd = lastDisableIdx >= firstEnableIdx ? entries[lastDisableIdx].timestamp : log.endTime;
  return trimEnd > trimStart ? [trimStart, trimEnd] : null;
}

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeLog, setActiveLog] = useState<string | null>(null);
  const [selectedFieldsByLog, setSelectedFieldsByLog] = useState<Map<string, Set<string>>>(new Map());
  const [trimByLog, setTrimByLog] = useState<Map<string, [number, number]>>(new Map());
  const [currentTime, setCurrentTime] = useState(0);
  const [tab, setTab] = useState<Tab>("chart");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [extractState, setExtractState] = useState<{ sources: ExtractSourceInfo[] } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const extractInputRef = useRef<HTMLInputElement>(null);

  const [, setTick] = useState(0);
  useEffect(() => {
    const anyLoading = logs.some((e) => e.loading);
    if (!anyLoading) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [logs]);

  const loadFile = useCallback(
    async (file: File, source: "manifest" | "upload") => {
      const key = file.name;
      const loadStartMs = Date.now();
      setLogs((prev) => {
        const exists = prev.some((e) => e.filename === key);
        const newEntry: LogEntry = {
          filename: key,
          log: null,
          error: null,
          loading: true,
          progress: 0,
          loadStartMs,
          source,
        };
        return exists
          ? prev.map((e) => (e.filename === key ? newEntry : e))
          : [...prev, newEntry];
      });

      const onProgress = (p: number) => {
        setLogs((prev) =>
          prev.map((e) => (e.filename === key ? { ...e, progress: p } : e))
        );
      };

      try {
        const parsed = await parseLogFile(file, onProgress);
        setLogs((prev) =>
          prev.map((e) =>
            e.filename === key
              ? { ...e, log: parsed, loading: false, progress: 1 }
              : e
          )
        );
        setActiveLog((current) => current ?? key);
      } catch (err) {
        setLogs((prev) =>
          prev.map((e) =>
            e.filename === key
              ? {
                  ...e,
                  error: err instanceof Error ? err.message : String(err),
                  loading: false,
                  progress: 0,
                }
              : e
          )
        );
      }
    },
    []
  );

  useEffect(() => {
    if (!authed) return;

    async function loadManifest() {
      let filenames: string[] = [];
      try {
        const res = await fetch("./logs/manifest.json");
        if (!res.ok) throw new Error(`manifest.json not found (${res.status})`);
        filenames = await res.json();
        if (!Array.isArray(filenames))
          throw new Error("manifest.json must be a JSON array of filenames");
      } catch (err) {
        setManifestError(err instanceof Error ? err.message : String(err));
        return;
      }

      if (filenames.length === 0) {
        setManifestError(
          "No log files listed in manifest.json — upload a file to get started."
        );
        return;
      }

      await Promise.all(
        filenames.map(async (filename) => {
          try {
            const file = await fetchLogFile(filename);
            await loadFile(file, "manifest");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setLogs((prev) => {
              const exists = prev.some((e) => e.filename === filename);
              const errEntry: LogEntry = {
                filename,
                log: null,
                error: msg,
                loading: false,
                progress: 0,
                loadStartMs: Date.now(),
                source: "manifest",
              };
              return exists
                ? prev.map((e) => (e.filename === filename ? errEntry : e))
                : [...prev, errEntry];
            });
          }
        })
      );
    }

    loadManifest();
  }, [authed, loadFile]);

  const handleUpload = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach((file) => loadFile(file, "upload"));
    },
    [loadFile]
  );

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleUpload(e.dataTransfer.files);
  };

  const activeEntry = logs.find((e) => e.filename === activeLog) ?? null;
  const log = activeEntry?.log ?? null;

  const handleSelectLog = useCallback(
    (filename: string) => {
      setActiveLog(filename);
      setShowCalc(false);
      const entry = logs.find((e) => e.filename === filename);
      if (entry?.log) {
        const trim = trimByLog.get(filename);
        setCurrentTime(trim ? trim[0] : entry.log.startTime);
      }
    },
    [logs, trimByLog]
  );

  useEffect(() => {
    if (log) setCurrentTime(log.startTime);
  }, [log]);

  const toggleField = useCallback((key: string) => {
    if (!activeLog) return;
    const filename = activeLog;
    setSelectedFieldsByLog((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(filename) ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      next.set(filename, set);
      return next;
    });
  }, [activeLog]);

  const activeSelectedFields = useMemo(
    () => (activeLog ? (selectedFieldsByLog.get(activeLog) ?? new Set<string>()) : new Set<string>()),
    [activeLog, selectedFieldsByLog]
  );

  const chartSelections = useMemo<LogSelection[]>(
    () =>
      logs
        .filter((e) => e.log && (selectedFieldsByLog.get(e.filename)?.size ?? 0) > 0)
        .map((e) => {
          const trim = trimByLog.get(e.filename);
          return {
            log: e.log!,
            fields: selectedFieldsByLog.get(e.filename)!,
            trimStart: trim?.[0],
            trimEnd: trim?.[1],
          };
        }),
    [logs, selectedFieldsByLog, trimByLog]
  );

  const activeTrimStart = log ? (trimByLog.get(log.filename)?.[0] ?? log.startTime) : 0;
  const activeTrimEnd = log ? (trimByLog.get(log.filename)?.[1] ?? log.endTime) : 0;

  const handleTrimChange = useCallback((start: number, end: number) => {
    if (!log) return;
    const filename = log.filename;
    setTrimByLog((prev) => {
      const next = new Map(prev);
      next.set(filename, [start, end]);
      return next;
    });
  }, [log]);

  const handleTrimReset = useCallback(() => {
    if (!log) return;
    const filename = log.filename;
    setTrimByLog((prev) => {
      const next = new Map(prev);
      next.delete(filename);
      return next;
    });
  }, [log]);

  const handleAutoTrim = useCallback(() => {
    if (!log) return;
    const range = findEnabledRange(log);
    if (range) handleTrimChange(range[0], range[1]);
  }, [log, handleTrimChange]);

  const handleRemoveLog = useCallback((filename: string) => {
    setLogs((prev) => prev.filter((e) => e.filename !== filename));
    setSelectedFieldsByLog((prev) => { const next = new Map(prev); next.delete(filename); return next; });
    setTrimByLog((prev) => { const next = new Map(prev); next.delete(filename); return next; });
    if (activeLog === filename) {
      const remaining = logs.filter((e) => e.filename !== filename);
      setActiveLog(remaining[0]?.filename ?? null);
    }
  }, [activeLog, logs]);

  const parsedLogs = useMemo(() => logs.flatMap((e) => e.log ? [e.log] : []), [logs]);

  const handleExtractFileSelected = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const sources: ExtractSourceInfo[] = [];
    for (const file of Array.from(files)) {
      const buffer = await file.arrayBuffer();
      const fields = scanWPILOGFieldNames(buffer);
      if (!fields) {
        alert(`${file.name} is not a valid WPILOG file.`);
        continue;
      }
      sources.push({ buffer, filename: file.name, fields });
    }
    if (sources.length > 0) setExtractState({ sources });
  }, []);

  const handleAddCalculatedField = useCallback((field: LogField) => {
    setLogs((prev) =>
      prev.map((entry) => {
        if (entry.filename !== activeLog || !entry.log) return entry;
        const newFields = { ...entry.log.fields, [field.key]: field };
        const updatedLog: ParsedLog = {
          ...entry.log,
          fields: newFields,
          fieldTree: buildFieldTree(newFields),
        };
        return { ...entry, log: updatedLog };
      })
    );
  }, [activeLog]);

  if (!authed) {
    return <PasswordGate onAuth={() => setAuthed(true)} />;
  }

  return (
    <div className="app" onDragOver={handleDragOver} onDrop={handleDrop}>
      <header className="topbar">
        <div className="topbar-left">
          <img src="/logo.svg" alt="469 Las Guerrillas" className="team-logo" />
          <span className="title">Online AdvantageScope</span>
          <span className="team-badge">Team 469</span>
        </div>

        <div className="topbar-right">
          {log && (
            <span className="file-info">
              {log.filename} &middot; {log.format} &middot;{" "}
              {Object.keys(log.fields).length} fields &middot;{" "}
              {(log.endTime - log.startTime).toFixed(2)}s
            </span>
          )}

          {log && (
            <button
              className={`btn-calc ${showCalc ? "active" : ""}`}
              onClick={() => setShowCalc((v) => !v)}
              title="Create calculated fields from existing data"
            >
              &fnof; Calc
            </button>
          )}

          <button
            className="btn-extract"
            onClick={() => extractInputRef.current?.click()}
            title="Quickly scan field names from any WPILOG file and export a subset — no full parse required"
          >
            &#9660; Extract Fields
          </button>

          {parsedLogs.length > 0 && (
            <button className="btn-export" onClick={() => setShowExport(true)} title="Export fields from loaded logs as WPILOG">
              &darr; Export WPILOG&hellip;
            </button>
          )}

          {parsedLogs.length > 0 && (
            <PowerAnalysisButton logs={parsedLogs} />
          )}

          <button
            className="btn-upload"
            onClick={() => uploadInputRef.current?.click()}
            title="Open a log file from your computer"
          >
            &#128194; Open file&hellip;
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".wpilog,.hoot,.revlog,.rlog,.dslog,.csv,.log"
            multiple
            style={{ display: "none" }}
            onChange={(e) => handleUpload(e.target.files)}
            onClick={(e) => ((e.target as HTMLInputElement).value = "")}
          />
          <input
            ref={extractInputRef}
            type="file"
            accept=".wpilog"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { handleExtractFileSelected(e.target.files); (e.target as HTMLInputElement).value = ""; }}
          />
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          {logs.length > 0 && (
            <div className="log-selector">
              <div className="sidebar-section-label">Log Files</div>
              {logs.map((entry) => {
                const isActive = activeLog === entry.filename;
                const eta = entry.loading ? formatEta(entry) : "";
                const pct = entry.loading
                  ? `${Math.round(entry.progress * 100)}%`
                  : "";

                return (
                  <button
                    key={entry.filename}
                    className={`log-tab ${isActive ? "active" : ""} ${entry.error ? "has-error" : ""}`}
                    onClick={() => !entry.loading && handleSelectLog(entry.filename)}
                    title={entry.error ?? entry.filename}
                  >
                    <span className="log-tab-name">{entry.filename}</span>
                    {entry.loading && (
                      <span className="log-tab-status">
                        {pct} {eta && <span className="eta">{eta}</span>}
                      </span>
                    )}
                    {entry.error && (
                      <span className="log-tab-badge error" title={entry.error}>!</span>
                    )}
                    <span
                      className="log-tab-remove"
                      role="button"
                      title="Remove"
                      onClick={(e) => { e.stopPropagation(); handleRemoveLog(entry.filename); }}
                    >
                      &#x2715;
                    </span>
                    {entry.loading && (
                      <div
                        className="log-tab-progress"
                        style={{ width: `${entry.progress * 100}%` }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {logs.length === 0 && (
            <div className="sidebar-status">
              <div className="drop-hint">
                <div className="drop-hint-icon">&#128194;</div>
                <p>Drop a log file anywhere</p>
                <p className="drop-hint-sub">or use &ldquo;Open file&hellip;&rdquo; above</p>
                {manifestError && (
                  <p className="drop-hint-error">{manifestError}</p>
                )}
              </div>
            </div>
          )}

          {log ? (
            <FieldTree
              tree={log.fieldTree}
              selectedFields={activeSelectedFields}
              onToggleField={toggleField}
            />
          ) : activeEntry?.loading ? (
            <div className="sidebar-status">
              <div className="sidebar-loading">
                <div className="spinner" />
                <p>Parsing {activeEntry.filename}&hellip;</p>
                <p className="progress-text">
                  {Math.round(activeEntry.progress * 100)}%
                  {formatEta(activeEntry) && (
                    <span className="eta"> &middot; ETA {formatEta(activeEntry)}</span>
                  )}
                </p>
              </div>
            </div>
          ) : activeEntry?.error ? (
            <div className="sidebar-status">
              <div className="sidebar-error">
                <strong>{activeEntry.filename}</strong>
                <br />
                {activeEntry.error}
              </div>
            </div>
          ) : logs.length > 0 ? (
            <div className="sidebar-status">
              <div className="drop-hint">
                <p>Select a log file above</p>
              </div>
            </div>
          ) : null}
        </aside>

        <main
          className="content"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {log ? (
            <>
              <div className="tab-bar">
                <button
                  className={`tab ${tab === "chart" ? "active" : ""}`}
                  onClick={() => setTab("chart")}
                >
                  Chart
                </button>
                <button
                  className={`tab ${tab === "table" ? "active" : ""}`}
                  onClick={() => setTab("table")}
                >
                  Values
                </button>
                <button
                  className={`tab ${tab === "stats" ? "active" : ""}`}
                  onClick={() => setTab("stats")}
                >
                  Stats
                </button>
                {chartSelections.length === 0 && (
                  <span className="tab-hint">&larr; Select fields from the sidebar</span>
                )}
              </div>

              <div className="main-view">
                {showCalc ? (
                  <CalculatedFields log={log} onAddField={handleAddCalculatedField} />
                ) : tab === "chart" ? (
                  <TimeChart
                    selections={chartSelections}
                    activeLog={log}
                    currentTime={currentTime}
                    onTimeChange={setCurrentTime}
                  />
                ) : tab === "table" ? (
                  <ValueTable
                    log={log}
                    selectedFields={activeSelectedFields}
                    currentTime={currentTime}
                  />
                ) : (
                  <StatsTable
                    log={log}
                    selectedFields={activeSelectedFields}
                    trimStart={activeTrimStart}
                    trimEnd={activeTrimEnd}
                  />
                )}
              </div>

              {!showCalc && (
                <TimeSlider
                  startTime={log.startTime}
                  endTime={log.endTime}
                  currentTime={currentTime}
                  onTimeChange={setCurrentTime}
                  trimStart={activeTrimStart}
                  trimEnd={activeTrimEnd}
                  onTrimChange={handleTrimChange}
                  onTrimReset={handleTrimReset}
                  onAutoTrim={handleAutoTrim}
                  hasEnabledField={ENABLED_CANDIDATES.some((c) => log.fields[c.key])}
                />
              )}
            </>
          ) : (
            <div className="main-empty">
              <div
                className="dropzone-main"
                onClick={() => uploadInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <img src="/logo.svg" alt="469 Las Guerrillas" className="empty-logo" />
                <p className="empty-title">Drop a log file to get started</p>
                <p className="empty-sub">
                  Supports WPILOG &middot; HOOT &middot; REVLOG &middot; RLOG &middot; DS Log &middot; CSV
                </p>
                <p className="empty-sub" style={{ marginTop: 4, opacity: 0.6 }}>
                  or click to browse
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {extractState && (
        <WPILOGExtractModal
          sources={extractState.sources}
          onClose={() => setExtractState(null)}
        />
      )}
      {showExport && (
        <ExportModal
          logs={parsedLogs}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
