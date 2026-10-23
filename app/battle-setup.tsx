'use client';

import { useState } from 'react';
import { RULESET_ID, RULESET_VERSION } from '../domain/polis-classical.js';

type ScenarioDocument = any;

interface BattleSetupProps {
  scenario: ScenarioDocument;
  problems: { message: string }[];
  onBegin: (controllers: Record<string, string>) => void;
  onOpenInEditor: () => void;
  onBack: () => void;
}

// Controllers offered per side. Random and Passive are labelled as test
// players; the engine accepts `human`, `random`, `passive`, and `automated`.
const CONTROLLER_OPTIONS = [
  { value: 'human', label: 'Human' },
  { value: 'random', label: 'Random (test player)' },
  { value: 'passive', label: 'Passive (test player)' },
];

// The setup screen: the side names and colours from the scenario, a
// controller per side, and the ruleset version. Begin runs playability
// validation first: a refusal lists every problem — each naming the unit and
// the reason — offers "Open in editor", and creates no battle.
export default function BattleSetup({
  scenario,
  problems,
  onBegin,
  onOpenInEditor,
  onBack,
}: BattleSetupProps) {
  const sides: any[] = Array.isArray(scenario?.sides) ? scenario.sides : [];
  const [controllers, setControllers] = useState<Record<string, string>>(() =>
    Object.fromEntries(sides.map((side) => [side?.id, 'human'])),
  );

  function setController(sideId: string, controller: string) {
    setControllers((current) => ({ ...current, [sideId]: controller }));
  }

  return (
    <div className="setup" data-testid="battle-setup">
      <span className="eyebrow">PÓLIS · BATTLE SETUP</span>
      <h1>{scenario?.title ?? 'Untitled scenario'}</h1>
      <p className="lede">
        Assign a controller per side, then Begin. Begin runs playability validation under the
        installed ruleset; the seed is drawn at Begin and never shown.
      </p>
      <div className="setup-card">
        <h2>Sides</h2>
        <p className="setup-meta" data-testid="setup-meta">
          {scenario?.battlefield?.width} × {scenario?.battlefield?.height} m ·{' '}
          {(scenario?.units || []).length} {(scenario?.units || []).length === 1 ? 'unit' : 'units'}
        </p>
        {sides.map((side) => (
          <div className="side-row" key={side?.id ?? side?.name}>
            <span className="swatch" style={{ background: side?.color ?? '#666' }} aria-hidden="true" />
            <span>
              <span className="side-name" data-testid={`setup-side-name-${side?.id}`}>
                {side?.name}
              </span>
              <br />
              <span className="side-id">{side?.id}</span>
            </span>
            <label>
              Controller
              <select
                data-testid={`controller-${side?.id}`}
                aria-label={`Controller for ${side?.name}`}
                value={controllers[side?.id] ?? 'human'}
                onChange={(event) => setController(side?.id, event.target.value)}
              >
                {CONTROLLER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
        <div className="kv" style={{ marginTop: 16 }}>
          <dt>Ruleset</dt>
          <dd className="mono" data-testid="setup-ruleset">
            {scenario?.ruleset?.id} {scenario?.ruleset?.version} (installed: {RULESET_ID}{' '}
            {RULESET_VERSION})
          </dd>
        </div>
        <div className="setup-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid="begin-battle"
            onClick={() => onBegin(controllers)}
          >
            Begin
          </button>
          <button type="button" className="btn-quiet" data-testid="setup-back" onClick={onBack}>
            Back to library
          </button>
        </div>
      </div>
      {problems.length > 0 ? (
        <div className="refusal" data-testid="playability-refusal" role="alert">
          <h2>Cannot begin: this scenario is unplayable under the installed ruleset</h2>
          <p>Every problem is listed below. No battle was created.</p>
          <ul className="problem-list" data-testid="problem-list">
            {problems.map((problem, index) => (
              <li key={index} data-testid="playability-problem">
                {problem.message}
              </li>
            ))}
          </ul>
          <div className="setup-actions">
            <button
              type="button"
              className="btn-secondary"
              data-testid="open-in-editor"
              onClick={onOpenInEditor}
            >
              Open in editor
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
