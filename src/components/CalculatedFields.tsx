import { useState, useCallback, useRef } from "react";
import type { ParsedLog, LogField } from "../types";

interface CalculatedFieldsProps {
  log: ParsedLog;
  onAddField: (field: LogField) => void;
}

// ── safe expression evaluator ────────────────────────────────────────────────
// Replaces field references {/some/field} with the value at each timestamp,
// then evaluates simple arithmetic + a few math functions.
// Uses a whitelist-only approach: no eval(), no Function().

type TokenType = "num" | "op" | "lparen" | "rparen" | "ident" | "eof";
interface Token { type: TokenType; value: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (/[0-9.]/.test(expr[i])) {
      let num = "";
      while (i < expr.length && /[0-9.eE+\-]/.test(expr[i])) num += expr[i++];
      tokens.push({ type: "num", value: num });
    } else if (/[+\-*/%^]/.test(expr[i])) {
      tokens.push({ type: "op", value: expr[i++] });
    } else if (expr[i] === "(") {
      tokens.push({ type: "lparen", value: "(" }); i++;
    } else if (expr[i] === ")") {
      tokens.push({ type: "rparen", value: ")" }); i++;
    } else if (/[a-zA-Z_]/.test(expr[i])) {
      let ident = "";
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) ident += expr[i++];
      tokens.push({ type: "ident", value: ident });
    } else {
      i++; // skip unknown chars
    }
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private values: Map<string, number>;

  constructor(tokens: Token[], values: Map<string, number>) {
    this.tokens = tokens;
    this.values = values;
  }

  private peek() { return this.tokens[this.pos]; }
  private consume() { return this.tokens[this.pos++]; }

  parse(): number { return this.parseExpr(); }

  private parseExpr(): number {
    return this.parseAddSub();
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.peek().type === "op" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.consume().value;
      const right = this.parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parsePow();
    while (this.peek().type === "op" && (this.peek().value === "*" || this.peek().value === "/" || this.peek().value === "%")) {
      const op = this.consume().value;
      const right = this.parsePow();
      if (op === "*") left = left * right;
      else if (op === "/") left = right !== 0 ? left / right : NaN;
      else left = left % right;
    }
    return left;
  }

  private parsePow(): number {
    const base = this.parseUnary();
    if (this.peek().type === "op" && this.peek().value === "^") {
      this.consume();
      return Math.pow(base, this.parsePow());
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek().type === "op" && this.peek().value === "-") {
      this.consume();
      return -this.parseAtom();
    }
    return this.parseAtom();
  }

  private parseAtom(): number {
    const t = this.peek();
    if (t.type === "num") {
      this.consume();
      return parseFloat(t.value);
    }
    if (t.type === "lparen") {
      this.consume();
      const v = this.parseExpr();
      if (this.peek().type === "rparen") this.consume();
      return v;
    }
    if (t.type === "ident") {
      this.consume();
      const fnName = t.value.toLowerCase();
      // Math functions
      if (this.peek().type === "lparen") {
        this.consume();
        const arg = this.parseExpr();
        if (this.peek().type === "rparen") this.consume();
        switch (fnName) {
          case "abs": return Math.abs(arg);
          case "sqrt": return Math.sqrt(arg);
          case "log": return Math.log(arg);
          case "log10": return Math.log10(arg);
          case "log2": return Math.log2(arg);
          case "exp": return Math.exp(arg);
          case "sin": return Math.sin(arg);
          case "cos": return Math.cos(arg);
          case "tan": return Math.tan(arg);
          case "asin": return Math.asin(arg);
          case "acos": return Math.acos(arg);
          case "atan": return Math.atan(arg);
          case "ceil": return Math.ceil(arg);
          case "floor": return Math.floor(arg);
          case "round": return Math.round(arg);
          case "sign": return Math.sign(arg);
          default: return arg;
        }
      }
      // Named constants
      if (fnName === "pi") return Math.PI;
      if (fnName === "e") return Math.E;
      // Variable reference
      return this.values.get(t.value) ?? 0;
    }
    return 0;
  }
}

function evalExpr(expr: string, values: Map<string, number>): number {
  try {
    const tokens = tokenize(expr);
    return new Parser(tokens, values).parse();
  } catch {
    return NaN;
  }
}

// Extract field placeholder names: tokens that match field keys in the log
function extractFieldRefs(expr: string, fieldKeys: string[]): string[] {
  const refs: string[] = [];
  // Sort by length desc so longer names match first
  const sorted = [...fieldKeys].sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    // Use sanitized ident name: replace non-alnum with _
    const ident = fieldKeyToIdent(k);
    if (expr.includes(ident) && !refs.includes(k)) refs.push(k);
  }
  return refs;
}

// Map a field key like "/Robot/Drive/Speed" to a valid identifier "Robot_Drive_Speed"
function fieldKeyToIdent(key: string): string {
  return key.replace(/^\//, "").replace(/[^a-zA-Z0-9]/g, "_");
}

const OPERATOR_BUTTONS = [
  { label: "+",      insert: " + " },
  { label: "−",      insert: " - " },
  { label: "×",      insert: " * " },
  { label: "÷",      insert: " / " },
  { label: "%",      insert: " % " },
  { label: "^",      insert: " ^ " },
  { label: "(",      insert: "("   },
  { label: ")",      insert: ")"   },
];

const FUNCTION_BUTTONS = [
  "abs", "sqrt", "log", "log10", "sin", "cos", "tan",
  "ceil", "floor", "round", "sign", "exp",
];

export function CalculatedFields({ log, onAddField }: CalculatedFieldsProps) {
  const [name, setName] = useState("");
  const [expr, setExpr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const exprRef = useRef<HTMLInputElement>(null);

  const numericFields = Object.values(log.fields).filter(
    (f) => f.type === "Number" || f.type === "Boolean"
  );

  const insertAtCursor = useCallback((text: string) => {
    const input = exprRef.current;
    setError(null);
    setPreview(null);
    if (!input) {
      setExpr((prev) => prev + text);
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const newExpr = input.value.slice(0, start) + text + input.value.slice(end);
    setExpr(newExpr);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + text.length, start + text.length);
    });
  }, []);

  const insertIdent = useCallback((key: string) => {
    insertAtCursor(fieldKeyToIdent(key) + " ");
  }, [insertAtCursor]);

  const handlePreview = useCallback(() => {
    setError(null);
    setPreview(null);
    if (!expr.trim()) { setError("Enter an expression"); return; }

    const refs = extractFieldRefs(expr, numericFields.map((f) => f.key));
    if (refs.length === 0) {
      const val = evalExpr(expr, new Map());
      setPreview(`Constant value: ${val}`);
      return;
    }

    // Test at the first common timestamp
    const firstTs = log.fields[refs[0]]?.entries[0]?.timestamp ?? log.startTime;
    const values = new Map<string, number>();
    for (const key of refs) {
      const field = log.fields[key];
      const entry = field?.entries.find((e) => e.timestamp >= firstTs);
      const v = entry ? (typeof entry.value === "boolean" ? (entry.value ? 1 : 0) : (entry.value as number)) : 0;
      values.set(fieldKeyToIdent(key), v);
    }
    const result = evalExpr(expr, values);
    if (isNaN(result)) { setError("Expression returned NaN — check field names and syntax"); return; }
    setPreview(`Sample value at T=${firstTs.toFixed(2)}s: ${result.toPrecision(6)}`);
  }, [expr, numericFields, log]);

  const handleCreate = useCallback(async () => {
    setError(null);
    setPreview(null);
    const trimName = name.trim();
    if (!trimName) { setError("Enter a field name"); return; }
    if (!expr.trim()) { setError("Enter an expression"); return; }
    if (log.fields[trimName]) { setError(`Field "${trimName}" already exists`); return; }

    const refs = extractFieldRefs(expr, numericFields.map((f) => f.key));

    // Build a unified timestamp list from all referenced fields
    const tsSet = new Set<number>();
    for (const key of refs) {
      for (const e of log.fields[key]?.entries ?? []) tsSet.add(e.timestamp);
    }
    // Also add all timestamps from first field if no refs (constant)
    if (refs.length === 0) {
      for (const e of Object.values(log.fields)[0]?.entries ?? []) tsSet.add(e.timestamp);
    }

    const timestamps = Array.from(tsSet).sort((a, b) => a - b);
    if (timestamps.length === 0) { setError("No timestamps found in referenced fields"); return; }

    setProgress(0);

    // Per-field advancing pointer for O(m+n) step-hold interpolation
    const ptrs = new Map<string, number>();
    for (const key of refs) ptrs.set(key, 0);

    const entries: { timestamp: number; value: number }[] = [];
    let lastYield = Date.now();

    for (let i = 0; i < timestamps.length; i++) {
      if (Date.now() - lastYield > 40) {
        setProgress(Math.round((i / timestamps.length) * 100));
        await new Promise<void>((r) => setTimeout(r, 0));
        lastYield = Date.now();
      }

      const ts = timestamps[i];
      const values = new Map<string, number>();

      for (const key of refs) {
        const field = log.fields[key];
        if (!field) { values.set(fieldKeyToIdent(key), 0); continue; }
        let ptr = ptrs.get(key)!;
        while (ptr + 1 < field.entries.length && field.entries[ptr + 1].timestamp <= ts) ptr++;
        ptrs.set(key, ptr);
        const entry = field.entries[ptr];
        const v = !entry || entry.timestamp > ts ? 0
          : typeof entry.value === "boolean" ? (entry.value ? 1 : 0)
          : (entry.value as number);
        values.set(fieldKeyToIdent(key), v);
      }

      const result = evalExpr(expr, values);
      if (isFinite(result)) entries.push({ timestamp: ts, value: result });
    }

    setProgress(null);

    if (entries.length === 0) { setError("Expression produced no finite values"); return; }

    const newField: LogField = {
      key: trimName,
      type: "Number",
      typeStr: "double",
      entries,
      metadata: `calculated:${expr}`,
    };

    onAddField(newField);
    setName("");
    setExpr("");
    setPreview(`Created "${trimName}" with ${entries.length} data points.`);
  }, [name, expr, numericFields, log, onAddField]);

  return (
    <div className="calc-panel">
      <div className="calc-title">Calculated Field</div>

      <div className="calc-form">
        <label className="calc-label">New field name</label>
        <input
          className="calc-input"
          placeholder="/MyCalc/result"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="calc-label">Expression</label>
        <input
          ref={exprRef}
          className="calc-input calc-expr"
          placeholder="e.g. Field_A * Field_B + 2.5"
          value={expr}
          onChange={(e) => { setExpr(e.target.value); setError(null); setPreview(null); }}
        />

        <div className="calc-op-row">
          {OPERATOR_BUTTONS.map((op) => (
            <button key={op.label} className="calc-op-btn" onClick={() => insertAtCursor(op.insert)}>
              {op.label}
            </button>
          ))}
          <span className="calc-op-sep" />
          {FUNCTION_BUTTONS.map((fn) => (
            <button key={fn} className="calc-fn-btn" onClick={() => insertAtCursor(fn + "(")}>
              {fn}
            </button>
          ))}
        </div>

        <div className="calc-buttons">
          <button className="calc-btn-preview" onClick={handlePreview} disabled={progress !== null}>Preview</button>
          <button className="calc-btn-create" onClick={handleCreate} disabled={progress !== null}>
            {progress !== null ? `Computing… ${progress}%` : "Create field"}
          </button>
        </div>
        {progress !== null && (
          <div className="calc-progress-wrap">
            <div className="calc-progress-bar" style={{ width: `${progress}%` }} />
          </div>
        )}
        {error && <div className="calc-error">{error}</div>}
        {preview && !error && <div className="calc-preview">{preview}</div>}
      </div>

      {numericFields.length > 0 && (
        <div className="calc-fields-list">
          <div className="calc-fields-label">Click to insert field name:</div>
          <div className="calc-fields-scroll">
            {numericFields.map((f) => (
              <button
                key={f.key}
                className="calc-field-chip"
                title={f.key}
                onClick={() => insertIdent(f.key)}
              >
                {fieldKeyToIdent(f.key)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
