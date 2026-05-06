import { useState, useEffect, useCallback } from "react";
import type { ParsedLog } from "./types";
import { parseLogFile } from "./parsers/index";
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

  // Load and parse all files listed in the manifest
  useEffect(() => {
    if (!authed) return;

    async function loadManifest() {
      let filenames: string[] = [];
      try {
        const res = await fetch("./logs/manifest.json");
        if (!res.ok) throw new Error(`manifest.json not found (${res.status})`);
        filenames = await res.json();
        if (!Array.isArray(filenames)) throw new Error("manifest.json must be a JSON array of filenames");
      } catch (err) {
        setManifestError(err instanceof Error ? err.message : String(err));
        return;
      }

      if (filenames.length === 0) {
        setManifestError("No log files listed in manifest.json. Add filenames to public/logs/manifest.json.");
        return;
      }

      // Initialize all entries as loading
      setLogs(filenames.map((f) => ({ filename: f, log: null, error: null, loading: true })));

      // Parse each file in parallel
      await Promise.all(
        filenames.map(async (filename) => {
          try {
            const file = await fetchLogFile(filename);
            const parsed = await parseLogFile(file);
            setLogs((prev) =>
              prev.map((e) =>
                e.filename === filename ? { ...e, log: parsed, loading: false } : e
              )
            );
            // Auto-select the first successful log
            setActiveLog((current) => current ?? filename);
          } catch (err) {
            setLogs((prev) =>
              prev.map((e) =>
                e.filename === filename
                  ? { ...e, error: err instanceof Error ? err.message : String(err), loading: false }
                  : e
              )
            );
          }
        })
      );
    }

    loadManifest();
  }, [authed]);

  const activeEntry = logs.find((e) => e.filename === activeLog) ?? null;
  const log = activeEntry?.log ?? null;

  const handleSelectLog = useCallback((filename: string) => {
    setActiveLog(filename);
    setSelectedFields(new Set());
    const entry = logs.find((e) => e.filename === filename);
    if (entry?.log) setCurrentTime(entry.log.startTime);
  }, [logs]);

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

  if (!authed) {
    return <PasswordGate onAuth={() => setAuthed(true)} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">📊</span>
          <span className="title">Online AdvantageScope</span>
        </div>
        {log && (
          <div className="topbar-right">
            <span className="file-info">
              {log.filename} · {log.format} ·{" "}
              {Object.keys(log.fields).length} fields ·{" "}
              {(log.endTime - log.startTime).toFixed(2)}s
            </span>
          </div>
        )}
      </header>

      <div className="workspace">
        {/* Left panel: log selector + field tree */}
        <aside className="sidebar">
          {logs.length > 1 && (
            <div className="log-selector">
              <div className="sidebar-section-label">Log Files</div>
              {logs.map((entry) => (
                <button
                  key={entry.filename}
                  className={`log-tab ${activeLog === entry.filename ? "active" : ""} ${entry.error ? "has-error" : ""}`}
                  onClick={() => handleSelectLog(entry.filename)}
                  title={entry.error ?? entry.filename}
                >
                  <span className="log-tab-name">{entry.filename}</span>
                  {entry.loading && <span className="log-tab-badge loading">…</span>}
                  {entry.error && <span className="log-tab-badge error">!</span>}
                </button>
              ))}
            </div>
          )}

          {log ? (
            <FieldTree
              tree={log.fieldTree}
              selectedFields={selectedFields}
              onToggleField={toggleField}
            />
          ) : (
            <div className="sidebar-status">
              {manifestError ? (
                <div className="sidebar-error">{manifestError}</div>
              ) : logs.length === 0 ? (
                <div className="sidebar-loading">
                  <div className="spinner" />
                  <p>Loading logs…</p>
                </div>
              ) : activeEntry?.loading ? (
                <div className="sidebar-loading">
                  <div className="spinner" />
                  <p>Parsing {activeEntry.filename}…</p>
                </div>
              ) : activeEntry?.error ? (
                <div className="sidebar-error">
                  <strong>{activeEntry.filename}</strong>
                  <br />
                  {activeEntry.error}
                </div>
              ) : null}
            </div>
          )}
        </aside>

        {/* Right panel: chart / table */}
        <main className="content">
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
              {manifestError ? (
                <div className="empty-card">
                  <div className="empty-icon">⚠️</div>
                  <p className="empty-title">No logs loaded</p>
                  <p className="empty-sub">{manifestError}</p>
                </div>
              ) : (
                <div className="empty-card">
                  <div className="empty-icon">📂</div>
                  <p className="empty-title">Loading log files…</p>
                  <p className="empty-sub">Fetching and parsing from <code>public/logs/</code></p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
