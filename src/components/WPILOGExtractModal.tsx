import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { WPILOGFieldInfo } from "../parsers/wpilogExtract";
import { extractWPILOGFields, downloadExtractedWPILOG } from "../parsers/wpilogExtract";

interface WPILOGExtractModalProps {
  buffer: ArrayBuffer;
  filename: string;
  fields: WPILOGFieldInfo[];
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

export function WPILOGExtractModal({ buffer, filename, fields, onClose }: WPILOGExtractModalProps) {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.name.toLowerCase().includes(q) || f.typeStr.toLowerCase().includes(q));
  }, [fields, search]);

  const toggle = useCallback((name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }, []);

  const selectVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of filtered) next.add(f.name);
      return next;
    });
  }, [filtered]);

  const clearVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of filtered) next.delete(f.name);
      return next;
    });
  }, [filtered]);

  const handleExport = useCallback(async () => {
    if (checked.size === 0 || exporting) return;
    setExporting(true);
    // Yield so the UI can update before the synchronous extraction
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      const extracted = extractWPILOGFields(buffer, checked);
      const base = filename.replace(/\.[^.]+$/, "");
      const suffix = checked.size === 1
        ? "_" + [...checked][0].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30)
        : `_${checked.size}fields`;
      downloadExtractedWPILOG(extracted, `${base}${suffix}.wpilog`);
      onClose();
    } finally {
      setExporting(false);
    }
  }, [buffer, filename, checked, exporting, onClose]);

  const visibleCheckedCount = useMemo(
    () => filtered.filter((f) => checked.has(f.name)).length,
    [filtered, checked]
  );
  const allVisibleChecked = filtered.length > 0 && visibleCheckedCount === filtered.length;

  return (
    <div className="extract-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="extract-modal">
        {/* header */}
        <div className="extract-header">
          <div className="extract-title">Extract WPILOG Fields</div>
          <div className="extract-subtitle">{filename} &middot; {fields.length} fields</div>
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
          {filtered.length === 0 && (
            <div className="extract-empty">No fields match "{search}"</div>
          )}
          {filtered.map((f) => (
            <label key={f.name} className={`extract-row ${checked.has(f.name) ? "checked" : ""}`}>
              <input
                type="checkbox"
                className="extract-checkbox"
                checked={checked.has(f.name)}
                onChange={() => toggle(f.name)}
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

        {/* footer */}
        <div className="extract-footer">
          <span className="extract-count">
            {checked.size === 0
              ? "No fields selected"
              : `${checked.size} field${checked.size !== 1 ? "s" : ""} selected`}
          </span>
          <button className="extract-cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="extract-export-btn"
            onClick={handleExport}
            disabled={checked.size === 0 || exporting}
          >
            {exporting ? "Extracting…" : `Extract & Download`}
          </button>
        </div>
      </div>
    </div>
  );
}
