import { useState, useEffect, useCallback, useRef } from "react";
import type { ParsedLog } from "./types";
import { parseLogFile } from "./parsers/index";
import { downloadWPILOG } from "./parsers/wpilogWriter";
import { PasswordGate, isAuthenticated } from "./components/PasswordGate";
import { FieldTree } from "./components/FieldTree";
import { TimeChart, ValueTable } from "./components/TimeChart";
import { TimeSlider } from "./components/TimeSlider";

type Tab = "chart" | "table";

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

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeLog, setActiveLog] = useState<string | null>(null);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(0);
  const [tab, setTab] = useState<Tab>("chart");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

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
      setSelectedFields(new Set());
      const entry = logs.find((e) => e.filename === filename);
      if (entry?.log) setCurrentTime(entry.log.startTime);
    },
    [logs]
  );

  useEffect(() => {
    if (log) setCurrentTime(log.startTime);
  }, [log]);

  const toggleField = useCallback((key: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    if (!log || selectedFields.size === 0) return;
    downloadWPILOG(log, Array.from(selectedFields));
  }, [log, selectedFields]);

  if (!authed) {
    return <PasswordGate onAuth={() => setAuthed(true)} />;
  }

  return (
    <div className="app" onDragOver={handleDragOver} onDrop={handleDrop}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">📊</span>
          <span className="title">Online AdvantageScope</span>
        </div>

        <div className="topbar-right">
          {log && (
            <span className="file-info">
              {log.filename} · {log.format} ·{" "}
              {Object.keys(log.fields).length} fields ·{" "}
              {(log.endTime - log.startTime).toFixed(2)}s
            </span>
          )}

          {selectedFields.size > 0 && log && (
            <button className="btn-export" onClick={handleExport} title="Save selected fields as a new WPILOG file">
              ⬇ Export {selectedFields.size} field{selectedFields.size !== 1 ? "s" : ""} as WPILOG
            </button>
          )}

          <button
            className="btn-upload"
            onClick={() => uploadInputRef.current?.click()}
            title="Open a log file from your computer"
          >
            📂 Open file…
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
                <div className="drop-hint-icon">📂</div>
                <p>Drop a log file anywhere</p>
                <p className="drop-hint-sub">or use "Open file…" above</p>
                {manifestError && (
                  <p className="drop-hint-error">{manifestError}</p>
                )}
              </div>
            </div>
          )}

          {log ? (
            <FieldTree
              tree={log.fieldTree}
              selectedFields={selectedFields}
              onToggleField={toggleField}
            />
          ) : activeEntry?.loading ? (
            <div className="sidebar-status">
              <div className="sidebar-loading">
                <div className="spinner" />
                <p>Parsing {activeEntry.filename}…</p>
                <p className="progress-text">
                  {Math.round(activeEntry.progress * 100)}%
                  {formatEta(activeEntry) && (
                    <span className="eta"> · ETA {formatEta(activeEntry)}</span>
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
                {selectedFields.size === 0 && (
                  <span className="tab-hint">← Select fields from the sidebar</span>
                )}
              </div>

              <div className="main-view">
                {tab === "chart" ? (
                  <TimeChart
                    log={log}
                    selectedFields={selectedFields}
                    currentTime={currentTime}
                    onTimeChange={setCurrentTime}
                  />
                ) : (
                  <ValueTable
                    log={log}
                    selectedFields={selectedFields}
                    currentTime={currentTime}
                  />
                )}
              </div>

              <TimeSlider
                startTime={log.startTime}
                endTime={log.endTime}
                currentTime={currentTime}
                onTimeChange={setCurrentTime}
              />
            </>
          ) : (
            <div className="main-empty">
              <div
                className="dropzone-main"
                onClick={() => uploadInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <div className="empty-icon">📂</div>
                <p className="empty-title">Drop a log file to get started</p>
                <p className="empty-sub">
                  Supports WPILOG · HOOT · REVLOG · RLOG · DS Log · CSV
                </p>
                <p className="empty-sub" style={{ marginTop: 4, opacity: 0.6 }}>
                  or click to browse
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
