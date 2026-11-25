'use client';

import {
  GROUND_COVER_CATEGORIES,
  LINEAR_FEATURE_CATEGORIES,
} from '../../domain/scenario.js';
import {
  DraftField,
  groundCoverLabel,
  linearLabel,
} from './editor-fields';
// Terrain and scenario inspector (draft, selected feature, scenario fields,
// issues). Verbatim move from ../editor: markup, data-testid attributes,
// class names and event handling are unchanged, and all state still lives in
// Editor and arrives through props.
export interface TerrainInspectorProps {
  document: any;
  fieldErrors: Record<string, string | null>;
  notice: any;
  terrainDraft: any;
  setTerrainDraft: (next: any) => void;
  selectedVertexIndex: any;
  sides: any[];
  errors: any[];
  warnings: any[];
  catalogueWarnings: any[];
  notices: any[];
  issueCount: any;
  selectedTerrain: any;
  groundAreaSquareMetres: (feature: any) => number | null;
  commitTerrainCategory: (id: string, category: string) => void;
  commitLinearCategory: (id: string, category: string) => void;
  commitLinearWidth: (id: string, raw: string) => void;
  deleteTerrainFeature: (id: string) => void;
  deleteTerrainVertex: (featureId: string, index: number) => void;
  fieldError: (field: string) => any;
  commitTitle: (raw: string) => void;
  commitDescription: (raw: string) => void;
  commitDimension: (dimension: 'width' | 'height', raw: string) => void;
  commitSideName: (index: number, raw: string) => void;
  commitSideColor: (index: number, raw: string) => void;
}

export function TerrainInspector(props: TerrainInspectorProps) {
  const {
    document,
    fieldErrors,
    notice,
    terrainDraft,
    setTerrainDraft,
    selectedVertexIndex,
    sides,
    errors,
    warnings,
    catalogueWarnings,
    notices,
    issueCount,
    selectedTerrain,
    groundAreaSquareMetres,
    commitTerrainCategory,
    commitLinearCategory,
    commitLinearWidth,
    deleteTerrainFeature,
    deleteTerrainVertex,
    fieldError,
    commitTitle,
    commitDescription,
    commitDimension,
    commitSideName,
    commitSideColor,
  }: TerrainInspectorProps = props;
  return (
    <>
          {terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label={
                terrainDraft.kind === 'linear'
                  ? 'River or road being drawn'
                  : terrainDraft.kind === 'elevation'
                    ? 'Hill being drawn'
                    : 'Area being drawn'
              }
              data-testid="terrain-inspector"
            >
              <h3>
                {terrainDraft.kind === 'linear'
                  ? `New ${linearLabel(terrainDraft.category)}`
                  : terrainDraft.kind === 'elevation'
                    ? 'New hill'
                    : `New ${groundCoverLabel(terrainDraft.category)} area`}
              </h3>
              {terrainDraft.kind === 'linear' ? (
                <>
                  <label className="field">
                    Category
                    <select
                      data-testid="terrain-draft-linear-category"
                      value={terrainDraft.category}
                      onChange={(event) =>
                        setTerrainDraft({ ...terrainDraft, category: event.target.value, error: '' })
                      }
                    >
                      {LINEAR_FEATURE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {linearLabel(category)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Width (m)
                    <input
                      type="number"
                      data-testid="terrain-draft-linear-width"
                      min={0.1}
                      step={0.1}
                      value={String(terrainDraft.width ?? '')}
                      onChange={(event) =>
                        setTerrainDraft({
                          ...terrainDraft,
                          width: Number(event.target.value),
                          error: '',
                        })
                      }
                    />
                  </label>
                </>
              ) : terrainDraft.kind === 'elevation' ? (
                <div className="kv">
                  <dt>Level</dt>
                  <dd>Derived from nesting when finished (inside level n becomes level n + 1)</dd>
                </div>
              ) : (
                <label className="field">
                  Category
                  <select
                    data-testid="terrain-draft-category"
                    value={terrainDraft.category}
                    onChange={(event) =>
                      setTerrainDraft({ ...terrainDraft, category: event.target.value, error: '' })
                    }
                  >
                    {GROUND_COVER_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {groundCoverLabel(category)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="kv">
                <dt>Vertices</dt>
                <dd>
                  {terrainDraft.points.length}{' '}
                  {terrainDraft.kind === 'linear' ? '(at least 2 to finish)' : '(at least 3 to finish)'}
                </dd>
              </div>
              {terrainDraft.error ? (
                <p className="field-error" role="alert">
                  {terrainDraft.error}
                </p>
              ) : null}
              {terrainDraft.kind === 'linear' ? (
                <p className="terrain-hint">
                  Set the category and width here; both travel with the finished line.
                </p>
              ) : null}
            </section>
          ) : null}
          {selectedTerrain && selectedTerrain.kind === 'linear' && !terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label="Selected river or road"
              data-testid="terrain-inspector"
            >
              <h3>{linearLabel(selectedTerrain.category)}</h3>
              <label className="field">
                Category
                <select
                  data-testid="terrain-linear-category"
                  value={selectedTerrain.category}
                  onChange={(event) =>
                    commitLinearCategory(selectedTerrain.id, event.target.value)
                  }
                >
                  {LINEAR_FEATURE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {linearLabel(category)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Width (m)
                <DraftField
                  testid="terrain-linear-width"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={String(selectedTerrain.width ?? '')}
                  error={fieldErrors['terrain-linear-width'] ?? null}
                  onCommit={(raw) => commitLinearWidth(selectedTerrain.id, raw)}
                />
              </label>
              {fieldError('terrain-linear-width')}
              <div className="kv">
                <dt>Vertices</dt>
                <dd>{selectedTerrain.path.length}</dd>
              </div>
              <ol className="terrain-vertex-list" data-testid="terrain-vertex-list">
                {selectedTerrain.path.map(
                  (point: { x: number; y: number }, index: number) => {
                    const active = index === selectedVertexIndex;
                    return (
                      <li
                        className={active ? 'terrain-vertex-row selected' : 'terrain-vertex-row'}
                        key={index}
                        data-testid="terrain-vertex-row"
                      >
                        <span className="mono">
                          {index + 1}. ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                        </span>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-vertex-delete"
                          data-index={index}
                          disabled={selectedTerrain.path.length <= 2}
                          onClick={() => deleteTerrainVertex(selectedTerrain.id, index)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  },
                )}
              </ol>
              <div className="terrain-actions">
                <button
                  type="button"
                  className="btn-secondary btn-danger"
                  data-testid="terrain-delete-feature"
                  onClick={() => deleteTerrainFeature(selectedTerrain.id)}
                >
                  Delete river or road
                </button>
              </div>
              <p className="terrain-hint">
                Drag a vertex on the map · click a small edge dot to insert a vertex · select a
                vertex and press Delete to remove it (at least two stay). Rivers and roads may
                cross everything.
              </p>
            </section>
          ) : null}
          {selectedTerrain && selectedTerrain.kind !== 'linear' && !terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label={
                selectedTerrain.kind === 'elevation' ? 'Selected hill' : 'Selected ground cover area'
              }
              data-testid="terrain-inspector"
            >
              <h3>
                {selectedTerrain.kind === 'elevation'
                  ? `Hill · level ${selectedTerrain.level}`
                  : `${groundCoverLabel(selectedTerrain.category)} area`}
              </h3>
              {selectedTerrain.kind === 'elevation' ? (
                <div className="kv">
                  <dt>Level</dt>
                  <dd data-testid="terrain-level">
                    {selectedTerrain.level} (derived from nesting — never typed)
                  </dd>
                </div>
              ) : (
                <label className="field">
                  Category
                  <select
                    data-testid="terrain-category"
                    value={selectedTerrain.category}
                    onChange={(event) =>
                      commitTerrainCategory(selectedTerrain.id, event.target.value)
                    }
                  >
                    {GROUND_COVER_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {groundCoverLabel(category)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="kv">
                <dt>Area</dt>
                <dd>
                  {(() => {
                    const area = groundAreaSquareMetres(selectedTerrain);
                    return area === null ? '—' : `${area.toLocaleString('en')} m²`;
                  })()}
                </dd>
              </div>
              <div className="kv">
                <dt>Vertices</dt>
                <dd>{selectedTerrain.polygon.length}</dd>
              </div>
              <ol className="terrain-vertex-list" data-testid="terrain-vertex-list">
                {selectedTerrain.polygon.map(
                  (point: { x: number; y: number }, index: number) => {
                    const active = index === selectedVertexIndex;
                    return (
                      <li
                        className={active ? 'terrain-vertex-row selected' : 'terrain-vertex-row'}
                        key={index}
                        data-testid="terrain-vertex-row"
                      >
                        <span className="mono">
                          {index + 1}. ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                        </span>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-vertex-delete"
                          data-index={index}
                          disabled={selectedTerrain.polygon.length <= 3}
                          onClick={() => deleteTerrainVertex(selectedTerrain.id, index)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  },
                )}
              </ol>
              <div className="terrain-actions">
                <button
                  type="button"
                  className="btn-secondary btn-danger"
                  data-testid="terrain-delete-feature"
                  onClick={() => deleteTerrainFeature(selectedTerrain.id)}
                >
                  {selectedTerrain.kind === 'elevation' ? 'Delete hill' : 'Delete area'}
                </button>
              </div>
              <p className="terrain-hint">
                Drag a vertex on the map · click a small edge dot to insert a vertex · select a
                vertex and press Delete to remove it (at least three stay).
              </p>
            </section>
          ) : null}
          <h2>Scenario</h2>
          <label className="field">
            Title
            <DraftField
              testid="inspector-title"
              value={document.title ?? ''}
              error={fieldErrors.title ?? null}
              maxLength={120}
              onCommit={commitTitle}
            />
          </label>
          {fieldError('title')}
          <label className="field">
            Description
            <DraftField
              testid="inspector-description"
              value={document.description ?? ''}
              error={fieldErrors.description ?? null}
              multiline
              rows={3}
              maxLength={2000}
              onCommit={commitDescription}
            />
          </label>
          {fieldError('description')}
          <div className="field-pair">
            <div>
              <label className="field">
                Width (m)
                <DraftField
                  testid="inspector-width"
                  type="number"
                  min={1}
                  step={0.1}
                  value={String(document.battlefield?.width ?? '')}
                  error={fieldErrors.width ?? null}
                  onCommit={(raw) => commitDimension('width', raw)}
                />
              </label>
              {fieldError('width')}
            </div>
            <div>
              <label className="field">
                Height (m)
                <DraftField
                  testid="inspector-height"
                  type="number"
                  min={1}
                  step={0.1}
                  value={String(document.battlefield?.height ?? '')}
                  error={fieldErrors.height ?? null}
                  onCommit={(raw) => commitDimension('height', raw)}
                />
              </label>
              {fieldError('height')}
            </div>
          </div>
          {sides.map((side, index) => (
            <div className="field-pair" key={side?.id ?? index}>
              <div>
                <label className="field">
                  {`Side ${index + 1} name`}
                  <DraftField
                    testid={`inspector-side-${index}`}
                    value={side?.name ?? ''}
                    error={fieldErrors[`side-name-${index}`] ?? null}
                    maxLength={60}
                    onCommit={(raw) => commitSideName(index, raw)}
                  />
                </label>
                {fieldError(`side-name-${index}`)}
              </div>
              <div>
                <label className="field">
                  Colour
                  <DraftField
                    testid={`inspector-side-color-${index}`}
                    type="color"
                    value={side?.color ?? '#888888'}
                    error={fieldErrors[`side-color-${index}`] ?? null}
                    onCommit={(raw) => commitSideColor(index, raw)}
                  />
                </label>
                {fieldError(`side-color-${index}`)}
              </div>
            </div>
          ))}
          <p className="readonly-note">Two sides, always: sides cannot be added or removed.</p>
          <dl>
            <div className="kv">
              <dt>Ruleset</dt>
              <dd className="mono" data-testid="inspector-ruleset">
                {document.ruleset?.id} {document.ruleset?.version}
              </dd>
            </div>
            <div className="kv">
              <dt>Terrain features</dt>
              <dd data-testid="inspector-terrain-count">
                {(Array.isArray(document.terrainFeatures) ? document.terrainFeatures : []).length}
              </dd>
            </div>
          </dl>
          <div className="issues" data-testid="issues-panel">
            <h3>
              Issues{issueCount ? <span data-testid="issue-count"> {issueCount}</span> : null}
            </h3>
            {errors.map((problem) => (
              <p className="issue issue-error" data-testid="issue-error" key={problem}>
                {problem}
              </p>
            ))}
            {warnings.map((warning) => (
              <p className="issue issue-warning" data-testid="issue-warning" key={warning}>
                {warning}
              </p>
            ))}
            {catalogueWarnings.map((warning) => (
              <p
                className="issue issue-warning"
                data-testid="unknown-troop-warning"
                key={warning}
              >
                {warning}
              </p>
            ))}
            {notices.map((notice) => (
              <p className="issue issue-info" data-testid="ruleset-notice" key={notice}>
                {notice}
              </p>
            ))}
            {issueCount === 0 ? <p className="issues-note">No warnings.</p> : null}
          </div>
    </>
  );
}
