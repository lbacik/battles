'use client';

import { useEffect, useState } from 'react';
import { getTroopType } from '../../domain/polis-classical.js';

type ScenarioDocument = any;

export function DraftField({
  testid,
  value,
  error,
  onCommit,
  multiline = false,
  ...rest
}: {
  testid: string;
  value: string;
  error: string | null;
  onCommit: (raw: string) => void;
  multiline?: boolean;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'onBlur'
> &
  Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'maxLength'>) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  // An outside change (undo, redo, reopen) refreshes the field, but never
  // clobbers a draft the author is still typing. Adjusted during render, not
  // in an effect, so the field never shows a stale value for a frame.
  const [synced, setSynced] = useState({ value, focused });
  if (synced.value !== value || synced.focused !== focused) {
    setSynced({ value, focused });
    if (!focused) {
      setDraft(value);
    }
  }

  // A refused commit reverts the field to the last committed value (the
  // document keeps it throughout): the typed value was never committed.
  const errorKey = error ?? '';
  useEffect(() => {
    if (errorKey) {
      setDraft(value);
    }
    // Revert only when a refusal appears, not while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorKey]);

  function commit(raw: string) {
    // An unchanged value is skipped, except while a refusal is showing:
    // re-entering the stored value then resolves it, and the commit handler
    // clears the error (an unchanged document adds no undo step).
    if (raw !== value || error) {
      onCommit(raw);
    }
  }

  function revert() {
    setDraft(value);
  }

  if (multiline) {
    return (
      <textarea
        data-testid={testid}
        data-committed={value}
        aria-invalid={error ? true : undefined}
        rows={rest.rows}
        maxLength={rest.maxLength}
        value={draft}
        onFocus={() => {
          setFocused(true);
          setDraft(value);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          setFocused(false);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            revert();
            event.currentTarget.blur();
          }
        }}
      />
    );
  }
  const { rows: _rows, maxLength, type, min, max, step, ...inputRest } = rest;
  return (
    <input
      data-testid={testid}
      data-committed={value}
      aria-invalid={error ? true : undefined}
      type={type}
      min={min}
      max={max}
      step={step}
      maxLength={maxLength}
      {...inputRest}
      value={draft}
      onFocus={() => {
        setFocused(true);
        setDraft(value);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        setFocused(false);
        commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && type !== 'color') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          revert();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sideColorFor(sides: ScenarioDocument[], unit: ScenarioDocument): string {
  const key = unit?.side ?? unit?.sideId;
  const side = (sides || []).find((entry) => entry && entry.id === key);
  return side && side.color ? String(side.color) : '#666666';
}

// The catalogue's spacing presets, in order. Shared by the preset matcher
// and the preset select so the two can never drift apart.
export const SPACING_PRESET_KEYS = ['close', 'normal', 'open'];

export function troopDisplayName(troopType: unknown): string {
  const entry = getTroopType(troopType as string) as any;
  return entry?.displayName || String(troopType ?? 'Unknown');
}

// Prototype variant A's formation diagram: one dot per file and rank,
// capped to fit the inspector. Dots only — the footprint on the map is the
// true-scale rectangle, never enlarged for display.
export function FormationDiagram({ files, ranks }: { files: number; ranks: number }) {
  const cols = Math.max(1, Math.min(Math.floor(files), 18));
  const rows = Math.max(1, Math.min(Math.floor(ranks), 9));
  const dots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      dots.push(
        <rect
          key={`${row}-${col}`}
          x={110 - cols * 4.7 + col * 9.4}
          y={32 + row * 6}
          width={5.5}
          height={3.8}
          rx={0.8}
          fill="currentColor"
          opacity={0.8 - row * 0.035}
        />,
      );
    }
  }
  return (
    <svg
      viewBox="0 0 220 95"
      role="img"
      aria-label={`Diagram: ${files} files, ${ranks} ranks`}
      data-testid="formation-diagram"
    >
      <path d="m102 13 8-7 8 7M110 6v16" fill="none" stroke="currentColor" opacity="0.6" />
      {dots}
    </svg>
  );
}

export const GROUND_COVER_LABELS: Record<string, string> = {
  forest: 'Forest',
  rough: 'Rough ground',
  water: 'Water',
  settlement: 'Settlement',
};

export function groundCoverLabel(category: unknown): string {
  return typeof category === 'string' && GROUND_COVER_LABELS[category]
    ? GROUND_COVER_LABELS[category]
    : 'Ground cover';
}

export const LINEAR_LABELS: Record<string, string> = {
  river: 'River',
  road: 'Road',
};

export function linearLabel(category: unknown): string {
  return typeof category === 'string' && LINEAR_LABELS[category]
    ? LINEAR_LABELS[category]
    : 'River or road';
}

export const GROUND_FILLS_FOR_PANEL: Record<string, { fill: string }> = {
  forest: { fill: '#aebc9c' },
  rough: { fill: '#d8d2b8' },
  water: { fill: '#b3cece' },
  settlement: { fill: '#d8cbb2' },
};

export const LINEAR_FILLS_FOR_PANEL: Record<string, { fill: string }> = {
  river: { fill: '#7fb3c8' },
  road: { fill: '#c9b98f' },
};
