'use client';

import {
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateLinearCandidate,
} from '../../domain/scenario.js';
import { polygonArea, round1 } from '../../domain/geometry.js';
import { errorMessage } from './editor-fields';

type ScenarioDocument = any;

// Terrain drawing state (Map editor tab): verbatim move of the Editor's
// terrain-draft helpers. Display-only state stays in Editor and arrives
// through deps; committed documents reach onChange.
export function createTerrainDraft(deps: any) {
  const { document, draftCategory, draftLinearCategory, draftLinearWidth, onChange, setDraftCategory, setDraftLinearCategory, setDraftLinearWidth, setFieldErrors, setSelectedTerrainId, setSelectedVertexIndex, setTerrainDraft, setTerrainRefusal, terrainDraft }: any = deps;

  // --- Terrain mode (ground cover areas and hills) --------------------------
  // The Map editor tab replaces the order of battle with the terrain panel.
  // Drawing, recategorising, vertex edits, and deletions all commit through
  // onChange, so every terrain change is undoable with no extra work. A
  // refused edit never reaches the document: the candidate ring is drawn in
  // red and the reason is shown until the next committed change.
  function terrainFeatureById(doc: ScenarioDocument, id: string | null): any {
    if (!id) return null;
    return (
      (doc?.terrainFeatures || []).find(
        (feature: any) =>
          feature?.id === id &&
          (feature.kind === 'ground' ||
            feature.kind === 'elevation' ||
            feature.kind === 'linear'),
      ) || null
    );
  }

  function groundAreaSquareMetres(feature: any): number | null {
    try {
      return Math.round(polygonArea(feature.polygon));
    } catch {
      return null;
    }
  }

  function addedTerrainFeature(before: ScenarioDocument, after: ScenarioDocument): any {
    const ids = new Set((before?.terrainFeatures || []).map((feature: any) => feature?.id));
    return (after?.terrainFeatures || []).find((feature: any) => feature && !ids.has(feature.id));
  }

  function startTerrainDraft(kind: 'ground' | 'elevation' | 'linear') {
    if (terrainDraft) return;
    if (kind === 'linear') {
      const width = Number(draftLinearWidth);
      setTerrainDraft({
        kind: 'linear',
        category: draftLinearCategory,
        points: [],
        width: Number.isFinite(width) && width > 0 ? width : 10,
        error: '',
      });
    } else {
      setTerrainDraft(
        kind === 'elevation'
          ? { kind: 'elevation', category: 'hill', points: [], error: '' }
          : { kind: 'ground', category: draftCategory, points: [], error: '' },
      );
    }
    setSelectedTerrainId(null);
    setSelectedVertexIndex(null);
    setTerrainRefusal(null);
  }

  function cancelTerrainDraft() {
    if (!terrainDraft) return;
    setTerrainDraft(null);
    setTerrainRefusal(null);
  }

  function addDraftPoint(point: { x: number; y: number }) {
    const rounded = { x: round1(point.x), y: round1(point.y) };
    setTerrainDraft((current: any) => {
      if (!current) return current;
      // A double click lands two vertices on the same spot: keep the first
      // and ignore the repeat, so the draft never holds a zero-length edge.
      const last = current.points[current.points.length - 1];
      if (last && last.x === rounded.x && last.y === rounded.y) return current;
      return { ...current, points: [...current.points, rounded], error: '' };
    });
    // A new vertex is a new attempt: the last refusal highlight goes away.
    setTerrainRefusal(null);
  }

  function popDraftVertex() {
    setTerrainDraft((current: any) =>
      current && current.points.length > 0
        ? { ...current, points: current.points.slice(0, -1), error: '' }
        : current,
    );
    setTerrainRefusal(null);
  }

  function finishTerrainDraft() {
    if (!terrainDraft) return;
    const draft = terrainDraft;
    // Rivers and roads are polylines with a width in metres: two vertices
    // suffice, crossings are never refused, and only degenerate input or an
    // invalid width stops the finish.
    if (draft.kind === 'linear') {
      if (draft.points.length < 2) {
        setTerrainDraft({ ...draft, error: 'A river or road needs at least 2 vertices.' });
        return;
      }
      const width = Number(draft.width);
      if (!Number.isFinite(width) || width <= 0) {
        setTerrainDraft({ ...draft, error: 'Width must be a positive number of metres.' });
        return;
      }
      const check = validateLinearCandidate(document, draft.points);
      if (!check.ok) {
        const detail = check.reason ?? 'invalid shape';
        const reason = `Cannot add a river or road: ${detail}.`;
        setTerrainDraft({
          ...draft,
          error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
        });
        setTerrainRefusal({ ring: check.path, reason, kind: 'linear' });
        return;
      }
      let next: ScenarioDocument;
      try {
        next = addLinearFeature(document, {
          category: draft.category,
          path: draft.points,
          width,
        });
      } catch (error) {
        const reason = errorMessage(error);
        setTerrainDraft({ ...draft, error: reason });
        setTerrainRefusal({ ring: draft.points, reason, kind: 'linear' });
        return;
      }
      const added = addedTerrainFeature(document, next);
      setDraftLinearCategory(draft.category);
      setDraftLinearWidth(String(width));
      setTerrainDraft(null);
      setSelectedTerrainId(added ? added.id : null);
      setSelectedVertexIndex(null);
      setTerrainRefusal(null);
      setFieldErrors({});
      onChange(next);
      return;
    }
    if (draft.kind === 'elevation') {
      if (draft.points.length < 3) {
        setTerrainDraft({ ...draft, error: 'A hill needs at least 3 vertices.' });
        return;
      }
      const check = validateElevationCandidate(document, draft.points);
      if (!check.ok) {
        const detail = check.reason ?? 'invalid shape';
        const reason = `Cannot add a hill: ${detail}.`;
        setTerrainDraft({
          ...draft,
          error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
        });
        setTerrainRefusal({ ring: check.ring, reason, conflictId: check.conflictId });
        return;
      }
      let next: ScenarioDocument;
      try {
        next = addElevationFeature(document, { polygon: draft.points });
      } catch (error) {
        const reason = errorMessage(error);
        setTerrainDraft({ ...draft, error: reason });
        setTerrainRefusal({ ring: draft.points, reason });
        return;
      }
      const added = addedTerrainFeature(document, next);
      setTerrainDraft(null);
      setSelectedTerrainId(added ? added.id : null);
      setSelectedVertexIndex(null);
      setTerrainRefusal(null);
      setFieldErrors({});
      onChange(next);
      return;
    }
    if (draft.points.length < 3) {
      setTerrainDraft({ ...draft, error: 'An area needs at least 3 vertices.' });
      return;
    }
    const check = validateGroundCoverCandidate(document, draft.points);
    if (!check.ok) {
      const detail = check.reason ?? 'invalid shape';
      const reason = `Cannot add a ground cover area: ${detail}.`;
      setTerrainDraft({
        ...draft,
        error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
      });
      setTerrainRefusal({ ring: check.ring, reason, conflictId: check.conflictId });
      return;
    }
    let next: ScenarioDocument;
    try {
      next = addGroundCoverFeature(document, { category: draft.category, polygon: draft.points });
    } catch (error) {
      const reason = errorMessage(error);
      setTerrainDraft({ ...draft, error: reason });
      setTerrainRefusal({ ring: draft.points, reason });
      return;
    }
    const added = addedTerrainFeature(document, next);
    setDraftCategory(draft.category);
    setTerrainDraft(null);
    setSelectedTerrainId(added ? added.id : null);
    setSelectedVertexIndex(null);
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  return { terrainFeatureById, groundAreaSquareMetres, startTerrainDraft, cancelTerrainDraft, addDraftPoint, popDraftVertex, finishTerrainDraft };
}
