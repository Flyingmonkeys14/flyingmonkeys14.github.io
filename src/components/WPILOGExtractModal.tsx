import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { WPILOGFieldInfo } from "../parsers/wpilogExtract";
import { extractWPILOGFields, mergeExtractWPILOGFields, downloadExtractedWPILOG } from "../parsers/wpilogExtract";

export interface ExtractSourceInfo {
  buffer: ArrayBuffer;
  filename: string;
  fields: WPILOGFieldInfo[];
}

interface WPILOGExtractModalProps {
  sources: ExtractSourceInfo[];
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  boolean:    "#4ade80",
  double:     "#60a5fa",
  float:      "#60a5fa",
  int:        "#60a5fa",
  int64:      "#60a5fa",
  string:     "#f59e0b",
  json:       "#f59e0b",
  "boolean[]": "#86efac",
  "double[]": "#93c5fd",
  "float[]":  "#93c5fd",
  "int[]":    "#93c5fd",
  "int64[]": "#93c5fd",
  "string[]": "#fcd34d",
};

function typeColor(typeStr: string): string {
  const t = typeStr.toLowerCase();
  if (TYPE_COLORS[t]) return TYPE_COLORS[t];
  if (t.startsWith("struct:")) return "#a78bfa";
  if (t.startsWith("proto:"))  return "#c084fc";
  return "#6b7280";
}

function typeLabel(typeStr: string): string {
  const t = typeStr.toLowerCase();
  if (t === "boolean")    return "bool";
  if (t === "double")     return "dbl";
  if (t === "float")      return "flt";
  if (t === "int" || t === "int64") return "int";
  if (t === "string")     return "str";
  if (t === "json")       return "json";
  if (t === "boolean[]")  return "B[]";
  if (t === "double[]" || t === "float[]") return "N[]";
  if (t === "int[]" || t === "int64[]")    return "N[]";
  if (t === "string[]")   return "S[]";
  if (t.startsWith("struct:")) return "struct";
  if (t.startsWith("proto:"))  return "proto";
  return "raw";
}

export function WPILOGExtractModal({ sources, onClose }: WPILOGExtractModalProps) {
  const [search, setSearch] = useState("");
  // Map<sourceIndex, Set<fieldName>>
  const [checked, setChecked] = useState<Map<number, Set<string>>>(() => new Map());
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredSources = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sources.map((src, idx) => ({
      idx,
      filename: src.filename,
      fields: q
        ? src.fields.filter((f) => f.name.toLowerCase().includes(q) || f.typeStr.toLowerCase().includes(q))
        : src.fields,
    })).filter((fs) => !q || fs.fields.length > 0);
  }, [sources, search]);

  const totalChecked = useMemo(() => {
    let n = 0;
    for (const s of checked.values()) n += s.size;
    return n;
  }, [checked]);

  const toggle = useCallback((sourceIdx: number, name: string) => {
    setChecked((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(sourceIdx) ?? []);
      s.has(name) ? s.delete(name) : s.add(name);
      next.set(sourceIdx, s);
      return next;
    });
  }, []);

  const allVisibleChecked = useMemo(() => {
    if (filteredSources.every((fs) => fs.fields.length === 0)) return false;
    return filteredSources.every((fs) =>
      fs.fields.every((f) => checked.get(fs.idx)?.has(f.name))
    );
  }, [filteredSources, checked]);

  const selectVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Map(prev);
      for (const fs of filteredSources) {
        const s = new Set(next.get(fs.idx) ?? []);
        for (const f of fs.fields) s.add(f.name);
        next.set(fs.idx, s);
      }
      return next;
    });
  }, [filteredSources]);

  const clearVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Map(prev);
      for (const fs of filteredSources) {
        const s = new Set(next.get(fs.idx) ?? []);
        for (const f of fs.fields) s.delete(f.name);
        next.set(fs.idx, s);
      }
      return next;
    });
  }, [filteredSources]);

  const handleExport = useCallback(async () => {
    if (totalChecked === 0 || exporting) return;
    setExporting(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      let outputBuffer: ArrayBuffer;
      let outputName: string;

      if (sources.length === 1) {
        const selectedNames = checked.get(0) ?? new Set<string>();
        outputBuffer = extractWPILOGFields(sources[0].buffer, selectedNames);
        const base = sources[0].filename.replace(/\.[^.]+$/, "");
        const suffix = selectedNames.size === 1
          ? "_" + [...selectedNames][0].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30)
          : `_${selectedNames.size}fields`;
        outputName = `${base}${suffix}.wpilog`;
      } else {
        const extractSources = sources.map((src, idx) => ({
          buffer: src.buffer,
          selectedNames: checked.get(idx) ?? new Set<string>(),
        }));
        outputBuffer = mergeExtractWPILOGFields(extractSources);
        outputName = `merged_${totalChecked}fields.wpilog`;
      }

      downloadExtractedWPILOG(outputBuffer, outputName);
      onClose();
    } finally {
      setExporting(false);
    }
  }, [sources, checked, totalChecked, exporting, onClose]);

  const totalFields = sources.reduce((n, s) => n + s.fields.length, 0);
  const subtitle = sources.length === 1
    ? `${sources[0].filename} · ${totalFields} fields`
    : `${sources.length} files · ${totalFields} total fields`;

  return (
    <div className="extract-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="extract-modal">
        {/* header */}
        <div className="extract-header">
          <div className="extract-title">Extract WPILOG Fields</div>
          <div className="extract-subtitle">{subtitle}</div>
          <button className="extract-close" onClick={onClose} title="Close">&#x2715;</button>
        </div>

        {/* search + bulk actions */}
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
            title={allVisibleChecked ? "Deselect all visible" : "Select all visible"}
          >
            {allVisibleChecked ? "Deselect all" : "Select all"}
            {search ? " visible" : ""}
          </button>
        </div>

        {/* field list */}
        <div className="extract-list">
          {filteredSources.length === 0 && (
            <div className="extract-empty">No fields match "{search}"</div>
          )}
          {filteredSources.map((fs) => {
            const sourceChecked = checked.get(fs.idx) ?? new Set<string>();
            const allSrcChecked = fs.fields.length > 0 && fs.fields.every((f) => sourceChecked.has(f.name));

            return (
              <div key={fs.idx}>
                {sources.length > 1 && (
                  <div className="extract-source-header">
                    <span className="extract-source-name" title={fs.filename}>{fs.filename}</span>
                    <button
                      className="extract-source-bulk"
                      onClick={() => {
                        setChecked((prev) => {
                          const next = new Map(prev);
                          const s = new Set(next.get(fs.idx) ?? []);
                          if (allSrcChecked) {
                            for (const f of fs.fields) s.delete(f.name);
                          } else {
                            for (const f of fs.fields) s.add(f.name);
                          }
                          next.set(fs.idx, s);
                          return next;
                        });
                      }}
                    >
                      {allSrcChecked ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                )}
                {fs.fields.map((f) => (
                  <label
                    key={f.name}
                    className={`extract-row ${sourceChecked.has(f.name) ? "checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="extract-checkbox"
                      checked={sourceChecked.has(f.name)}
                      onChange={() => toggle(fs.idx, f.name)}
                    />
                    <span className="extract-field-name">{f.name}</span>
                    <span
                      className="extract-type-badge"
                      style={{ background: typeColor(f.typeStr) }}
                      title={f.typeStr}
                    >
                      {typeLabel(f.typeStr)}
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>

        {/* footer */}
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
            {exporting ? "Extracting…" : "Extract & Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
