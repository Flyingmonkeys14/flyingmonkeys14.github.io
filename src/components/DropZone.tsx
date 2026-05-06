import { useRef, useState } from "react";

const SUPPORTED = ".wpilog, .hoot, .revlog, .rlog, .dslog, .csv, .log";

interface DropZoneProps {
  onFile: (file: File) => void;
  isLoading: boolean;
}

export function DropZone({ onFile, isLoading }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = "";
  };

  if (isLoading) {
    return (
      <div className="dropzone loading">
        <div className="spinner" />
        <p>Parsing log file…</p>
      </div>
    );
  }

  return (
    <div
      className={`dropzone ${dragging ? "drag-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <div className="dropzone-icon">📂</div>
      <p className="dropzone-title">Drop a log file here</p>
      <p className="dropzone-sub">or click to browse</p>
      <p className="dropzone-formats">
        Supported: WPILOG · HOOT · REVLOG · RLOG · DS Log · CSV
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={SUPPORTED}
        style={{ display: "none" }}
        onChange={handleFile}
      />
    </div>
  );
}
