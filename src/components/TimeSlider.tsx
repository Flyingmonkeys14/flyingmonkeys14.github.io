interface TimeSliderProps {
  startTime: number;
  endTime: number;
  currentTime: number;
  onTimeChange: (t: number) => void;
}

export function TimeSlider({ startTime, endTime, currentTime, onTimeChange }: TimeSliderProps) {
  const duration = endTime - startTime;
  const relative = currentTime - startTime;

  return (
    <div className="time-slider">
      <span className="time-label">T+{relative.toFixed(3)}s</span>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.001}
        value={relative}
        onChange={(e) => onTimeChange(startTime + parseFloat(e.target.value))}
        className="slider"
      />
      <span className="time-label">{duration.toFixed(1)}s</span>
    </div>
  );
}
