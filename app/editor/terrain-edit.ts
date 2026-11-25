'use client';

import {
  normalizeFacing,
  proposeUnitPatch,
  unitPosition,
  removeElevationFeature,
  removeGroundCoverFeature,
  removeLinearFeature,
  updateElevationFeature,
  updateGroundCoverFeature,
  updateLinearFeature,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateLinearCandidate,
} from '../../domain/scenario.js';
import { round1 } from '../../domain/geometry.js';
import { errorMessage } from './editor-fields';

import { useEffect, useEffectEvent } from 'react';

type ScenarioDocument = any;

// Terrain and geometry commits: verbatim move of the Editor's selection,
// recategorise, vertex-edit and unit-geometry helpers. Draft callbacks
// (cancel/finish/pop) and shared lookups arrive through deps.
export function useTerrainEdits(deps: any) {
  const { cancelTerrainDraft, document, errors, fail, finishTerrainDraft, mode, onChange, popDraftVertex, selectedTerrainId, selectedVertexIndex, setFieldErrors, setNotice, setSelectedTerrainId, setSelectedUnitId, setSelectedVertexIndex, setTerrainRefusal, setUnitConflictIds, terrainDraft, terrainFeatureById }: any = deps;
  function selectTerrain(id: string, vertexIndex: number | null = null) {
    setSelectedTerrainId(id);
    setSelectedVertexIndex(vertexIndex);
    setTerrainRefusal(null);
  }

  function commitTerrainCategory(id: string, category: string) {
    let next: ScenarioDocument;
    try {
      next = updateGroundCoverFeature(document, id, { category });
    } catch (error) {
      const feature = terrainFeatureById(document, id);
      setTerrainRefusal({
        ring: Array.isArray(feature?.polygon) ? feature.polygon : [],
        reason: errorMessage(error),
      });
      return;
    }
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  function commitLinearCategory(id: string, category: string) {
    let next: ScenarioDocument;
    try {
      next = updateLinearFeature(document, id, { category });
    } catch (error) {
      const feature = terrainFeatureById(document, id);
      setTerrainRefusal({
        ring: Array.isArray(feature?.path) ? feature.path : [],
        reason: errorMessage(error),
        kind: 'linear',
      });
      return;
    }
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  function commitLinearWidth(id: string, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed)) || Number(trimmed) <= 0) {
      fail('terrain-linear-width', 'Width must be a positive number of metres.');
      return;
    }
    try {
      onChange(updateLinearFeature(document, id, { width: Number(trimmed) }));
      setFieldErrors({});
      setTerrainRefusal(null);
    } catch (error) {
      fail('terrain-linear-width', errorMessage(error));
    }
  }

  function deleteTerrainFeature(id: string) {
    const feature = terrainFeatureById(document, id);
    if (!feature) return;
    let next: ScenarioDocument;
    try {
      next =
        feature.kind === 'linear'
          ? removeLinearFeature(document, id)
          : feature.kind === 'elevation'
            ? removeElevationFeature(document, id)
            : removeGroundCoverFeature(document, id);
    } catch (error) {
      const failedRing = feature.kind === 'linear' ? feature.path : feature?.polygon;
      setTerrainRefusal({
        ring: Array.isArray(failedRing) ? failedRing : [],
        reason: errorMessage(error),
        ...(feature.kind === 'linear' ? { kind: 'linear' as const } : {}),
      });
      return;
    }
    if (selectedTerrainId === id) {
      setSelectedTerrainId(null);
      setSelectedVertexIndex(null);
    }
    setTerrainRefusal(null);
    onChange(next);
  }

  function validateTerrainPolygon(
    feature: any,
    polygon: { x: number; y: number }[],
    ignoreId: string,
  ) {
    return feature?.kind === 'elevation'
      ? validateElevationCandidate(document, polygon, { ignoreId })
      : validateGroundCoverCandidate(document, polygon, { ignoreId });
  }

  function updateTerrainPolygon(feature: any, id: string, ring: { x: number; y: number }[]) {
    return feature?.kind === 'elevation'
      ? updateElevationFeature(document, id, { polygon: ring })
      : updateGroundCoverFeature(document, id, { polygon: ring });
  }

  function insertTerrainVertex(featureId: string, edgeIndex: number) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    // A river or road is an open polyline: edges run between consecutive
    // vertices only, never wrapping from the last back to the first.
    if (feature.kind === 'linear') {
      if (!Array.isArray(feature.path)) return;
      const a = feature.path[edgeIndex];
      const b = feature.path[edgeIndex + 1];
      if (!a || !b) return;
      const path = [
        ...feature.path.slice(0, edgeIndex + 1),
        { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) },
        ...feature.path.slice(edgeIndex + 1),
      ];
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot insert a vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(edgeIndex + 1);
      return;
    }
    if (!Array.isArray(feature.polygon)) return;
    const ring = feature.polygon;
    const a = ring[edgeIndex];
    const b = ring[(edgeIndex + 1) % ring.length];
    if (!a || !b) return;
    const polygon = [
      ...ring.slice(0, edgeIndex + 1),
      { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) },
      ...ring.slice(edgeIndex + 1),
    ];
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot insert a vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(edgeIndex + 1);
  }

  function deleteTerrainVertex(featureId: string, index: number) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    if (feature.kind === 'linear') {
      if (!feature.path?.[index]) return;
      if (feature.path.length <= 2) {
        setTerrainRefusal({
          ring: feature.path,
          reason: 'A river or road needs at least 2 vertices: the vertex stays.',
          kind: 'linear',
        });
        return;
      }
      const path = feature.path.filter((_: unknown, other: number) => other !== index);
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot delete the vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(null);
      return;
    }
    if (!feature.polygon?.[index]) return;
    if (feature.polygon.length <= 3) {
      setTerrainRefusal({
        ring: feature.polygon,
        reason:
          feature.kind === 'elevation'
            ? 'A hill needs at least 3 vertices: the vertex stays.'
            : 'An area needs at least 3 vertices: the vertex stays.',
      });
      return;
    }
    const polygon = feature.polygon.filter((_: unknown, other: number) => other !== index);
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot delete the vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(null);
  }

  function commitTerrainVertex(
    featureId: string,
    index: number,
    point: { x: number; y: number },
  ) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    if (feature.kind === 'linear') {
      if (!feature.path?.[index]) return;
      const path = feature.path.map((vertex: { x: number; y: number }, other: number) =>
        other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
      );
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot move the vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(index);
      return;
    }
    if (!feature.polygon?.[index]) return;
    const polygon = feature.polygon.map((vertex: { x: number; y: number }, other: number) =>
      other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
    );
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot move the vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(index);
  }

  // Drop a terrain selection the document no longer holds (after undo,
  // redo, or reopening) so the panels never show a ghost.
  useEffect(() => {
    if (
      selectedTerrainId &&
      !(document?.terrainFeatures || []).some(
        (feature: any) => feature?.id === selectedTerrainId,
      )
    ) {
      setSelectedTerrainId(null);
      setSelectedVertexIndex(null);
    }
  }, [document, selectedTerrainId]);

  // Terrain drawing and vertex keys. Enter finishes the polygon, Escape
  // cancels it, Backspace removes the last vertex; with no draft, Delete
  // removes the selected vertex and Escape clears the selection. Typing in a
  // field is never stolen. Undo and redo keep their own shortcut. An Effect
  // Event reads the current draft and selection, so the listener is attached
  // once and Enter right after the last vertex click finishes the full shape.
  const onTerrainKey = useEffectEvent((event: KeyboardEvent) => {
    if (mode !== 'map') return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (terrainDraft) {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishTerrainDraft();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelTerrainDraft();
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        popDraftVertex();
      }
      return;
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      selectedTerrainId &&
      selectedVertexIndex !== null
    ) {
      event.preventDefault();
      deleteTerrainVertex(selectedTerrainId, selectedVertexIndex);
      return;
    }
    if (event.key === 'Escape' && selectedTerrainId) {
      setSelectedTerrainId(null);
      setSelectedVertexIndex(null);
      setTerrainRefusal(null);
    }
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onTerrainKey(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // --- Unit placement (map drag, rotation handle, inspector fields) ----------
  // Every geometry change goes through proposeUnitPatch: a change whose
  // footprint would overlap another unit or leave the battlefield is refused,
  // the value is never committed, the field reverts, and every conflicting
  // unit is highlighted on the map and in the order of battle. Touching
  // edge to edge is accepted. Each committed change is one undo step.
  function commitUnitGeometry(
    unitId: string,
    patch: { position?: { x: number; y: number }; facing?: number },
    field: string,
  ) {
    const proposal = proposeUnitPatch(document, unitId, patch);
    if (!proposal.ok) {
      setFieldErrors({ [field]: proposal.errors[0] || 'This placement is not allowed.' });
      setUnitConflictIds(proposal.conflictIds ?? []);
      return;
    }
    setFieldErrors({});
    setNotice(null);
    onChange(proposal.document);
  }

  function handleMoveUnit(unitId: string, position: { x: number; y: number }) {
    setSelectedUnitId(unitId);
    commitUnitGeometry(unitId, { position }, 'unit-position');
  }

  function handleRotateUnit(unitId: string, facing: number) {
    setSelectedUnitId(unitId);
    commitUnitGeometry(unitId, { facing }, 'unit-facing');
  }

  // Exact placement on the map: the front-edge midpoint in metres and the
  // compass facing in degrees.
  function commitUnitPositionAxis(unit: ScenarioDocument, axis: 'x' | 'y', raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      setFieldErrors({ 'unit-position': 'Position must hold finite X and Y metre coordinates.' });
      setUnitConflictIds(unit?.id ? [unit.id] : []);
      return;
    }
    const current = unitPosition(unit);
    const position = {
      x: axis === 'x' ? Number(trimmed) : (current?.x ?? Number.NaN),
      y: axis === 'y' ? Number(trimmed) : (current?.y ?? Number.NaN),
    };
    if (current && position.x === current.x && position.y === current.y) {
      setFieldErrors({});
      return;
    }
    commitUnitGeometry(unit?.id, { position }, 'unit-position');
  }

  function commitUnitFacing(unit: ScenarioDocument, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      setFieldErrors({ 'unit-facing': 'Facing must be a compass bearing in degrees.' });
      setUnitConflictIds(unit?.id ? [unit.id] : []);
      return;
    }
    if (normalizeFacing(Number(trimmed)) === normalizeFacing(Number(unit?.facing))) {
      setFieldErrors({});
      return;
    }
    commitUnitGeometry(unit?.id, { facing: Number(trimmed) }, 'unit-facing');
  }

  return { selectTerrain, commitTerrainCategory, commitLinearCategory, commitLinearWidth, deleteTerrainFeature, validateTerrainPolygon, updateTerrainPolygon, insertTerrainVertex, deleteTerrainVertex, commitTerrainVertex, commitUnitGeometry, handleMoveUnit, handleRotateUnit, commitUnitPositionAxis, commitUnitFacing };
}
