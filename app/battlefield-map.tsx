'use client';

// Empty battlefield drawn to scale: the true-scale rectangle of the scenario's
// battlefield in map metres (origin south-west, x east, y north per ADR 0001).
// Only rendering flips the vertical axis. Nothing predefined appears here:
// no units, no terrain features, no place names, no compass flourishes.

interface BattlefieldMapProps {
  width: number;
  height: number;
}

const GRID_STEP_M = 100;
const PAD_M = 60;

function gridLines(size: number): number[] {
  const lines: number[] = [];
  for (let value = GRID_STEP_M; value < size; value += GRID_STEP_M) {
    lines.push(value);
  }
  return lines;
}

export default function BattlefieldMap({ width, height }: BattlefieldMapProps) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1200;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 800;
  const viewBox = `${-PAD_M} ${-PAD_M} ${safeWidth + PAD_M * 2} ${safeHeight + PAD_M * 2}`;

  return (
    <svg
      id="battle-svg"
      data-testid="battlefield-map"
      data-width={safeWidth}
      data-height={safeHeight}
      viewBox={viewBox}
      role="img"
      aria-label={`Battlefield, ${safeWidth} by ${safeHeight} metres, origin south-west`}
    >
      <g transform={`translate(0 ${safeHeight}) scale(1 -1)`}>
        <rect
          x={-PAD_M}
          y={-PAD_M}
          width={safeWidth + PAD_M * 2}
          height={safeHeight + PAD_M * 2}
          fill="#e8e5d5"
        />
        {gridLines(safeWidth).map((x) => (
          <line key={`v${x}`} x1={x} y1={0} x2={x} y2={safeHeight} stroke="#d9dccb" strokeWidth={1} />
        ))}
        {gridLines(safeHeight).map((y) => (
          <line key={`h${y}`} x1={0} y1={y} x2={safeWidth} y2={y} stroke="#d9dccb" strokeWidth={1} />
        ))}
        <rect
          x={0}
          y={0}
          width={safeWidth}
          height={safeHeight}
          fill="#f4f3e9"
          stroke="#8b957e"
          strokeWidth={2}
        />
      </g>
    </svg>
  );
}
