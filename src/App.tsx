import { useState, useCallback } from "react";
import type { ParsedLog, ParseState } from "./types";
import { parseLogFile } from "./parsers/index";
import { DropZone } from "./components/DropZone";
import { FieldTree } from "./components/FieldTree";
import { TimeChart, ValueTable } from "./components/TimeChart";
import { TimeSlider } from "./components/TimeSlider";

type Tab = "chart" | "table";

export default function App() {
  const [parseState, setParseState] = useState<ParseState>({ status: "idle" });
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(0);
  const [tab, setTab] = useState<Tab>("chart");

  const log: ParsedLog | null = parseState.status === "done" ? parseState.log : null;

  const handleFile = useCallback(async (file: File) => {
    setParseState({ status: "parsing" });
    setSelectedFields(new Set());
    try {
      const parsed = await parseLogFile(file);
      setParseState({ status: "done", log: parsed });
      setCurrentTime(parsed.startTime);
    } catch (err) {
      setParseState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const toggleField = useCallback((key: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
            <button
              className="btn-secondary"
              onClick={() => {
                setParseState({ status: "idle" });
                setSelectedFields(new Set());
              }}
            >
              Open new file
            </button>
          </div>
        )}
      </header>

      {!log ? (
        <main className="main-center">
          <DropZone
            onFile={handleFile}
            isLoading={parseState.status === "parsing"}
          />
          {parseState.status === "error" && (
            <div className="error-box">
              <strong>Error:</strong> {parseState.message}
            </div>
          )}
        </main>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <FieldTree
              tree={log.fieldTree}
              selectedFields={selectedFields}
              onToggleField={toggleField}
            />
          </aside>

          <main className="content">
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
          </main>
        </div>
      )}
    </div>
  );
}
