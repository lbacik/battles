'use client';

import {
  TROOP_TYPE_CATALOGUE,
  TROOP_TYPE_KEYS,
  getTroopType,
} from '../../domain/polis-classical.js';
import {
  DraftField,
  FormationDiagram,
  SPACING_PRESET_KEYS,
} from './editor-fields';
// Selected-unit inspector. Verbatim move from ../editor: markup,
// data-testid attributes, class names and event handling are unchanged, and
// all state still lives in Editor and arrives through props.
export interface UnitInspectorProps {
  selectedUnit: any;
  selectedDerived: any;
  selectedSpacingClass: any;
  selectedPosition: any;
  selectedFacing: any;
  fieldErrors: Record<string, string | null>;
  terrainDraft: any;
  sides: any[];
  presetKeyFor: (unit: any) => string;
  handleDuplicateUnit: (unit: any) => void;
  handleDeleteUnit: (unit: any) => void;
  commitUnitName: (unit: any, raw: string) => void;
  commitUnitSide: (unit: any, sideId: string) => void;
  commitUnitTroopType: (unit: any, troopType: string) => void;
  commitUnitNumbers: (unit: any, patch: { soldiers?: string; files?: string }) => void;
  commitUnitSpacing: (unit: any, key: any, raw: string) => void;
  commitUnitPreset: (unit: any, presetKey: string) => void;
  commitUnitPositionAxis: (unit: any, axis: 'x' | 'y', raw: string) => void;
  commitUnitFacing: (unit: any, raw: string) => void;
  fieldError: (field: string) => any;
}

export function UnitInspector(props: UnitInspectorProps) {
  const {
    selectedUnit,
    selectedDerived,
    selectedSpacingClass,
    selectedPosition,
    selectedFacing,
    fieldErrors,
    terrainDraft,
    sides,
    presetKeyFor,
    handleDuplicateUnit,
    handleDeleteUnit,
    commitUnitName,
    commitUnitSide,
    commitUnitTroopType,
    commitUnitNumbers,
    commitUnitSpacing,
    commitUnitPreset,
    commitUnitPositionAxis,
    commitUnitFacing,
    fieldError,
  }: UnitInspectorProps = props;
  return (
    <>
          {selectedUnit ? (
            <>
              <section aria-label="Selected unit" data-testid="unit-inspector">
                <span className="eyebrow">SELECTED UNIT</span>
                <h3 data-testid="unit-title">{selectedUnit.name || 'Unit'}</h3>
                {selectedDerived ? (
                  <p className="derived-line" data-testid="unit-derived">
                    {selectedDerived.ranks} {selectedDerived.ranks === 1 ? 'rank' : 'ranks'} ·{' '}
                    {selectedDerived.frontageM.toFixed(1)} m frontage ·{' '}
                    {selectedDerived.depthM.toFixed(1)} m depth
                    {selectedSpacingClass ? ` · ${selectedSpacingClass} spacing` : ''}
                  </p>
                ) : (
                  <p className="derived-line" data-testid="unit-derived">
                    Ranks, frontage, and depth follow from soldiers, files, and spacings.
                  </p>
                )}
                {selectedDerived &&
                Number.isInteger(selectedDerived.ranks) &&
                Number.isInteger(selectedUnit.files) &&
                selectedUnit.files >= 1 ? (
                  <>
                    <div className="formation-preview">
                      <FormationDiagram
                        files={selectedUnit.files}
                        ranks={selectedDerived.ranks ?? 0}
                      />
                      <span>FORMATION DIAGRAM</span>
                    </div>
                  </>
                ) : null}
                <label className="field">
                  Unit name
                  <DraftField
                    testid="unit-name"
                    value={selectedUnit.name ?? ''}
                    error={fieldErrors['unit-name'] ?? null}
                    maxLength={60}
                    onCommit={(raw) => commitUnitName(selectedUnit, raw)}
                  />
                </label>
                {fieldError('unit-name')}
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Side
                      <select
                        data-testid="unit-side"
                        value={selectedUnit.side ?? ''}
                        onChange={(event) => commitUnitSide(selectedUnit, event.target.value)}
                        aria-invalid={fieldErrors['unit-side'] ? true : undefined}
                      >
                        {sides.map((side) => (
                          <option key={side?.id} value={side?.id}>
                            {side?.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {fieldError('unit-side')}
                  </div>
                  <div>
                    <label className="field">
                      Troop type
                      <select
                        data-testid="unit-troop"
                        value={selectedUnit.troopType ?? ''}
                        onChange={(event) => commitUnitTroopType(selectedUnit, event.target.value)}
                        aria-invalid={fieldErrors['unit-troop'] ? true : undefined}
                      >
                        {TROOP_TYPE_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {(TROOP_TYPE_CATALOGUE as any)[key]?.displayName || key}
                          </option>
                        ))}
                      </select>
                    </label>
                    {fieldError('unit-troop')}
                  </div>
                </div>
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Soldiers
                      <DraftField
                        testid="unit-soldiers"
                        type="number"
                        min={1}
                        step={1}
                        value={String(selectedUnit.soldiers ?? '')}
                        error={fieldErrors['unit-soldiers'] ?? null}
                        onCommit={(raw) => commitUnitNumbers(selectedUnit, { soldiers: raw })}
                      />
                    </label>
                    {fieldError('unit-soldiers')}
                  </div>
                  <div>
                    <label className="field">
                      Files
                      <DraftField
                        testid="unit-files"
                        type="number"
                        min={1}
                        step={1}
                        value={String(selectedUnit.files ?? '')}
                        error={fieldErrors['unit-files'] ?? null}
                        onCommit={(raw) => commitUnitNumbers(selectedUnit, { files: raw })}
                      />
                    </label>
                    {fieldError('unit-files')}
                  </div>
                </div>
                <label className="field">
                  Spacing preset
                  <select
                    data-testid="unit-preset"
                    value={presetKeyFor(selectedUnit)}
                    onChange={(event) => commitUnitPreset(selectedUnit, event.target.value)}
                    aria-invalid={fieldErrors['unit-preset'] ? true : undefined}
                  >
                    {presetKeyFor(selectedUnit) === 'custom' ? (
                      <option value="custom">Custom spacings</option>
                    ) : null}
                    {SPACING_PRESET_KEYS.map((key) => {
                      const preset = (getTroopType(selectedUnit.troopType) as any)?.presets?.[key];
                      const label = preset
                        ? `${key} (${preset.lateralInterval} × ${preset.rankDepth} m)`
                        : key;
                      return (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {fieldError('unit-preset')}
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Lateral interval (m)
                      <DraftField
                        testid="unit-spacing-lateral"
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={String(selectedUnit.lateralInterval ?? '')}
                        error={fieldErrors['unit-spacing-lateral'] ?? null}
                        onCommit={(raw) =>
                          commitUnitSpacing(selectedUnit, 'lateralInterval', raw)
                        }
                      />
                    </label>
                    {fieldError('unit-spacing-lateral')}
                  </div>
                  <div>
                    <label className="field">
                      Rank depth (m)
                      <DraftField
                        testid="unit-spacing-depth"
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={String(selectedUnit.rankDepth ?? '')}
                        error={fieldErrors['unit-spacing-depth'] ?? null}
                        onCommit={(raw) => commitUnitSpacing(selectedUnit, 'rankDepth', raw)}
                      />
                    </label>
                    {fieldError('unit-spacing-depth')}
                  </div>
                </div>
                <p className="preset-note">
                  A spacing preset pre-fills both spacings in metres; the scenario stores the
                  metres (the preset itself is not stored).
                </p>
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Position X — front midpoint (m)
                      <DraftField
                        testid="unit-position-x"
                        type="number"
                        step={0.1}
                        value={selectedPosition ? String(selectedPosition.x) : ''}
                        error={fieldErrors['unit-position'] ?? null}
                        onCommit={(raw) => commitUnitPositionAxis(selectedUnit, 'x', raw)}
                      />
                    </label>
                  </div>
                  <div>
                    <label className="field">
                      Position Y — front midpoint (m)
                      <DraftField
                        testid="unit-position-y"
                        type="number"
                        step={0.1}
                        value={selectedPosition ? String(selectedPosition.y) : ''}
                        error={fieldErrors['unit-position'] ?? null}
                        onCommit={(raw) => commitUnitPositionAxis(selectedUnit, 'y', raw)}
                      />
                    </label>
                  </div>
                </div>
                {fieldError('unit-position')}
                <label className="field">
                  Facing (°)
                  <DraftField
                    testid="unit-facing"
                    type="number"
                    min={0}
                    max={360}
                    step={1}
                    value={selectedFacing !== null ? String(selectedFacing) : ''}
                    error={fieldErrors['unit-facing'] ?? null}
                    onCommit={(raw) => commitUnitFacing(selectedUnit, raw)}
                  />
                </label>
                {fieldError('unit-facing')}
                <p className="preset-note">
                  Position is the midpoint of the front edge in metres; facing is a compass
                  bearing (0 = north, clockwise). Dragging the footprint or its round handle
                  edits the same values.
                </p>
                <div className="unit-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="unit-duplicate"
                    onClick={() => handleDuplicateUnit(selectedUnit)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="btn-quiet btn-danger"
                    data-testid="unit-delete"
                    onClick={() => handleDeleteUnit(selectedUnit)}
                  >
                    Delete
                  </button>
                </div>
                {fieldError('unit-delete')}
              </section>
              <hr className="panel-divider" />
            </>
          ) : null}
    </>
  );
}
