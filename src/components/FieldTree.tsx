import { useState, useMemo } from "react";
import type { LogFieldTree, LoggableType } from "../types";

interface FieldTreeProps {
  tree: LogFieldTree;
  selectedFields: Set<string>;
  onToggleField: (key: string) => void;
}

interface NodeProps {
  name: string;
  node: LogFieldTree;
  selectedFields: Set<string>;
  onToggleField: (key: string) => void;
  depth: number;
}

const TYPE_COLORS: Record<string, string> = {
  Boolean: "#4ade80",
  Number: "#60a5fa",
  String: "#f59e0b",
  BooleanArray: "#86efac",
  NumberArray: "#93c5fd",
  StringArray: "#fcd34d",
  Raw: "#a78bfa",
  Empty: "#6b7280",
};

const TYPE_ABBR: Record<string, string> = {
  Boolean: "B",
  Number: "N",
  String: "S",
  BooleanArray: "B[]",
  NumberArray: "N[]",
  StringArray: "S[]",
  Raw: "raw",
  Empty: "…",
};

function TreeNode({ name, node, selectedFields, onToggleField, depth }: NodeProps) {
  const hasChildren = Object.keys(node.children).length > 0;
  const isSelected = node.fullKey ? selectedFields.has(node.fullKey) : false;
  const [expanded, setExpanded] = useState(depth < 2);

  const canSelect = node.fullKey !== null && node.type !== "Empty" && node.type !== "Raw";

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <div
        className={`tree-node ${isSelected ? "selected" : ""} ${canSelect ? "selectable" : ""}`}
        onClick={() => {
          if (hasChildren) setExpanded((e) => !e);
          if (canSelect && node.fullKey) onToggleField(node.fullKey);
        }}
        title={node.fullKey ?? undefined}
      >
        {hasChildren && (
          <span className="tree-arrow">{expanded ? "▾" : "▸"}</span>
        )}
        {!hasChildren && <span className="tree-arrow" style={{ opacity: 0 }}>▸</span>}

        <span className="tree-name">{name}</span>

        {node.type && node.type !== "Empty" && (
          <span
            className="type-badge"
            style={{ background: TYPE_COLORS[node.type] ?? "#6b7280" }}
            title={node.type}
          >
            {TYPE_ABBR[node.type] ?? node.type}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <div>
          {Object.entries(node.children)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([childName, childNode]) => (
              <TreeNode
                key={childName}
                name={childName}
                node={childNode}
                selectedFields={selectedFields}
                onToggleField={onToggleField}
                depth={depth + 1}
              />
            ))}
        </div>
      )}
    </div>
  );
}

interface FlatField {
  fullKey: string;
  type: LoggableType | undefined;
}

function flattenFields(node: LogFieldTree): FlatField[] {
  const result: FlatField[] = [];
  if (node.fullKey && node.type && node.type !== "Empty") {
    result.push({ fullKey: node.fullKey, type: node.type });
  }
  for (const child of Object.values(node.children)) {
    result.push(...flattenFields(child));
  }
  return result;
}

export function FieldTree({ tree, selectedFields, onToggleField }: FieldTreeProps) {
  const [search, setSearch] = useState("");

  const allFlat = useMemo(
    () => flattenFields(tree).sort((a, b) => a.fullKey.localeCompare(b.fullKey)),
    [tree]
  );

  const flatFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return allFlat.filter((f) => f.fullKey.toLowerCase().includes(q));
  }, [allFlat, search]);

  const treeEntries = useMemo(
    () => Object.entries(tree.children).sort(([a], [b]) => a.localeCompare(b)),
    [tree]
  );

  return (
    <div className="field-tree">
      <div className="field-tree-header">
        <span>Fields</span>
        {selectedFields.size > 0 && (
          <span className="field-count">{selectedFields.size} selected</span>
        )}
      </div>
      <input
        className="search-input"
        placeholder="Search fields…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="tree-scroll">
        {flatFiltered ? (
          <>
            {flatFiltered.map((f) => {
              const canSelect = f.type && f.type !== "Raw";
              const isSelected = selectedFields.has(f.fullKey);
              return (
                <div
                  key={f.fullKey}
                  className={`tree-node ${isSelected ? "selected" : ""} ${canSelect ? "selectable" : ""}`}
                  onClick={() => canSelect && onToggleField(f.fullKey)}
                  title={f.fullKey}
                >
                  <span className="tree-arrow" style={{ opacity: 0 }}>▸</span>
                  <span className="tree-name">{f.fullKey.replace(/^\//, "")}</span>
                  {f.type && f.type !== "Empty" && (
                    <span
                      className="type-badge"
                      style={{ background: TYPE_COLORS[f.type] ?? "#6b7280" }}
                      title={f.type}
                    >
                      {TYPE_ABBR[f.type] ?? f.type}
                    </span>
                  )}
                </div>
              );
            })}
            {flatFiltered.length === 0 && (
              <div className="empty-state">No fields match "{search}"</div>
            )}
          </>
        ) : (
          <>
            {treeEntries.map(([name, node]) => (
              <TreeNode
                key={name}
                name={name}
                node={node}
                selectedFields={selectedFields}
                onToggleField={onToggleField}
                depth={0}
              />
            ))}
            {treeEntries.length === 0 && (
              <div className="empty-state">No fields available</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
