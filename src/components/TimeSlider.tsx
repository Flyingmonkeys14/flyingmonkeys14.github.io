interface TimeSliderProps {
  startTime: number;
  endTime: number;
  currentTime: number;
  onTimeChange: (t: number) => void;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (start: number, end: number) => void;
  onTrimReset: () => void;
}

export function TimeSlider({
  startTime, endTime, currentTime, onTimeChange,
  trimStart, trimEnd, onTrimChange, onTrimReset,
}: TimeSliderProps) {
  const duration = endTime - startTime;
  const trimDuration = trimEnd - trimStart;
  const hasTrim = trimStart > startTime || trimEnd < endTime;

  const relCurrent = Math.max(0, Math.min(trimDuration, currentTime - trimStart));

  const trimStartSec = trimStart - startTime;
  const trimEndSec = trimEnd - startTime;

  return (
    <div className="time-slider-area">
      <div className="time-slider">
        <span className="time-label">T+{relCurrent.toFixed(3)}s</span>
        <input
          type="range"
          min={0}
          max={trimDuration}
          step={0.001}
          value={relCurrent}
          onChange={(e) => onTimeChange(trimStart + parseFloat(e.target.value))}
          className="slider"
        />
        <span className="time-label">{trimDuration.toFixed(1)}s</span>
      </div>

      <div className="trim-row">
        <span className="trim-label">Trim:</span>
        <label className="trim-field">
          <span>start</span>
          <input
            type="number"
            className="trim-input"
            min={0}
            max={Math.max(0, trimEndSec - 0.1)}
            step={0.1}
            value={trimStartSec.toFixed(1)}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v >= 0 && v < trimEndSec) {
                onTrimChange(startTime + v, trimEnd);
              }
            }}
          />
          <span>s</span>
        </label>
        <label className="trim-field">
          <span>end</span>
          <input
            type="number"
            className="trim-input"
            min={trimStartSec + 0.1}
            max={duration}
            step={0.1}
            value={trimEndSec.toFixed(1)}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > trimStartSec && v <= duration) {
                onTrimChange(trimStart, startTime + v);
              }
            }}
          />
          <span>s</span>
        </label>
        <span className="trim-total">of {duration.toFixed(1)}s total</span>
        {hasTrim && (
          <button className="trim-reset-btn" onClick={onTrimReset}>
            Reset trim
          </button>
        )}
      </div>
    </div>
  );
}
