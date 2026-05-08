import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { ParsedLog } from "../types";
import { downloadWPILOG } from "../parsers/wpilogWriter";

interface ExportModalProps {
  logs: ParsedLog[];
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  Boolean:     "#4ade80",
  Number:      "#60a5fa",
  String:      "#f59e0b",
  BooleanArray:"#86efac",
  NumberArray: "#93c5fd",
  StringArray: "#fcd34d",
  Raw:         "#6b7280",
  Empty:       "#4b5563",
};

function typeColor(typeStr: string): string {
  return TYPE_COLORS[typeStr] ?? "#6b7280";
}

function typeLabel(typeStr: string): string {
  const abbr: Record<string, string> = {
    Boolean: "bool", Number: "num", String: "str",
    BooleanArray: "B[]", NumberArray: "N[]", StringArray: "S[]",
    Raw: "raw", Empty: "—",
  };
  return abbr[typeStr] ?? typeStr.slice(0, 5);
}

export function ExportModal({ logs, onClose }: ExportModalProps) {
  const [search, setSearch] = useState("");
  // Map<logFilename, Set<fieldKey>>
  const [checked, setChecked] = useState<Map<string, Set<string>>>(() => new Map());
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.map((log) => {
      const allKeys = Object.keys(log.fields);
      const keys = q
        ? allKeys.filter((k) => k.toLowerCase().includes(q) || log.fields[k].typeStr.toLowerCase().includes(q))
        : allKeys;
      return { log, keys };
    }).filter((item) => !q || item.keys.length > 0);
  }, [logs, search]);

  const totalChecked = useMemo(() => {
    let n = 0;
    for (const s of checked.values()) n += s.size;
    return n;
  }, [checked]);

  const allVisibleChecked = useMemo(() => {
    const allVisible = filteredLogs.flatMap((item) => item.keys);
    if (allVisible.length === 0) return false;
    return filteredLogs.every((item) =>
      item.keys.every((k) => checked.get(item.log.filename)?.has(k))
    );
  }, [filteredLogs, checked]);

  const toggle = useCallback((filename: string, key: string) => {
    setChecked((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(filename) ?? []);
      s.has(key) ? s.delete(key) : s.add(key);
      next.set(filename, s);
      return next;
    });
  }, []);

  const selectVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Map(prev);
      for (const { log, keys } of filteredLogs) {
        const s = new Set(next.get(log.filename) ?? []);
        for (const k of keys) s.add(k);
        next.set(log.filename, s);
      }
      return next;
    });
  }, [filteredLogs]);

  const clearVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Map(prev);
      for (const { log, keys } of filteredLogs) {
        const s = new Set(next.get(log.filename) ?? []);
        for (const k of keys) s.delete(k);
        next.set(log.filename, s);
      }
      return next;
    });
  }, [filteredLogs]);

  const handleExport = useCallback(async () => {
    if (totalChecked === 0 || exporting) return;
    setExporting(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      for (const log of logs) {
        const selectedKeys = checked.get(log.filename);
        if (!selectedKeys || selectedKeys.size === 0) continue;
        downloadWPILOG(log, Array.from(selectedKeys));
      }
      onClose();
    } finally {
      setExporting(false);
    }
  }, [logs, checked, totalChecked, exporting, onClose]);

  const totalFields = logs.reduce((n, l) => n + Object.keys(l.fields).length, 0);
  const subtitle = logs.length === 1
    ? `${logs[0].filename} · ${totalFields} fields`
    : `${logs.length} files · ${totalFields} total fields`;

  return (
    <div className="extract-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="extract-modal">
        <div className="extract-header">
          <div className="extract-title">Export as WPILOG</div>
          <div className="extract-subtitle">{subtitle}</div>
          <button className="extract-close" onClick={onClose} title="Close">&#x2715;</button>
        </div>

        <div className="extract-toolbar">
          <input
            ref={searchRef}
            className="extract-search"
            placeholder="Search field names or types…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="extract-bulk-btn"
            onClick={allVisibleChecked ? clearVisible : selectVisible}
          >
            {allVisibleChecked ? "Deselect all" : "Select all"}
            {search ? " visible" : ""}
          </button>
        </div>

        <div className="extract-list">
          {filteredLogs.length === 0 && (
            <div className="extract-empty">No fields match &ldquo;{search}&rdquo;</div>
          )}
          {filteredLogs.map(({ log, keys }) => {
            const logChecked = checked.get(log.filename) ?? new Set<string>();
            const allLogChecked = keys.length > 0 && keys.every((k) => logChecked.has(k));

            return (
              <div key={log.filename}>
                <div className="extract-source-header">
                  <span className="extract-source-name" title={log.filename}>{log.filename}</span>
                  <button
                    className="extract-source-bulk"
                    onClick={() => {
                      setChecked((prev) => {
                        const next = new Map(prev);
                        const s = new Set(next.get(log.filename) ?? []);
                        if (allLogChecked) {
                          for (const k of keys) s.delete(k);
                        } else {
                          for (const k of keys) s.add(k);
                        }
                        next.set(log.filename, s);
                        return next;
                      });
                    }}
                  >
                    {allLogChecked ? "Deselect all" : "Select all"}
                  </button>
                </div>
                {keys.map((key) => {
                  const field = log.fields[key];
                  return (
                    <label
                      key={key}
                      className={`extract-row ${logChecked.has(key) ? "checked" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="extract-checkbox"
                        checked={logChecked.has(key)}
                        onChange={() => toggle(log.filename, key)}
                      />
                      <span className="extract-field-name">{key.replace(/^\//, "")}</span>
                      <span
                        className="extract-type-badge"
                        style={{ background: typeColor(field.type) }}
                        title={field.typeStr}
                      >
                        {typeLabel(field.type)}
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="extract-footer">
          <span className="extract-count">
            {totalChecked === 0
              ? "No fields selected"
              : `${totalChecked} field${totalChecked !== 1 ? "s" : ""} selected`}
          </span>
          <button className="extract-cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="extract-export-btn"
            onClick={handleExport}
            disabled={totalChecked === 0 || exporting}
          >
            {exporting ? "Exporting…" : "Export & Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
