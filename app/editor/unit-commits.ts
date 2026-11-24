'use client';

import { getTroopType } from '../../domain/polis-classical.js';
import {
  createUnit,
  deleteUnit,
  duplicateUnit,
  updateUnitName,
  updateUnitNumbers,
  updateUnitSide,
  updateUnitSpacing,
  updateUnitTroopType,
} from '../../domain/scenario.js';
import { SPACING_PRESET_KEYS, errorMessage } from './editor-fields';

type ScenarioDocument = any;

// Unit commits (order of battle): verbatim move of the Editor's unit
// helpers. All document changes go through onChange (one undo step each);
// refusals revert the field and report through fail/setFieldErrors.
// Which spacing preset the selected unit's spacings match, or 'custom'.

export function createUnitCommits(deps: any) {
  const { document, fail, onChange, oobTab, selectedUnitId, setFieldErrors, setNotice, setSelectedUnitId, sides }: any = deps;
  function presetKeyFor(unit: ScenarioDocument): string {
    const entry = getTroopType(unit?.troopType) as any;
    if (!entry || !Number.isFinite(unit?.lateralInterval) || !Number.isFinite(unit?.rankDepth)) {
      return 'custom';
    }
    for (const key of SPACING_PRESET_KEYS) {
      const preset = entry.presets?.[key];
      if (
        preset &&
        Math.abs(preset.lateralInterval - unit.lateralInterval) < 1e-9 &&
        Math.abs(preset.rankDepth - unit.rankDepth) < 1e-9
      ) {
        return key;
      }
    }
    return 'custom';
  }

  function handleAddUnit() {
    const targetSide = oobTab !== 'all' ? oobTab : sides[0]?.id;
    try {
      // A new unit is a hoplite standing at its normal preset: the scenario
      // stores the preset's metres (ADR 0002), read from the catalogue here
      // so a catalogue change moves the default with it.
      const normalPreset = (getTroopType('hoplite') as any)?.presets?.normal;
      const next = createUnit(document, {
        sideId: targetSide,
        ...(normalPreset
          ? {
              lateralInterval: normalPreset.lateralInterval,
              rankDepth: normalPreset.rankDepth,
            }
          : {}),
      });
      setSelectedUnitId(next.unitId);
      setFieldErrors({});
      setNotice(null);
      onChange(next.document);
    } catch (error) {
      setFieldErrors({});
      setNotice(errorMessage(error));
    }
  }

  function handleDuplicateUnit(unit: ScenarioDocument) {
    try {
      const next = duplicateUnit(document, unit?.id);
      setSelectedUnitId(next.unitId);
      setFieldErrors({});
      setNotice(null);
      onChange(next.document);
    } catch (error) {
      setFieldErrors({});
      setNotice(errorMessage(error));
    }
  }

  function handleDeleteUnit(unit: ScenarioDocument) {
    try {
      onChange(deleteUnit(document, unit?.id));
      if (selectedUnitId === unit?.id) {
        setSelectedUnitId(null);
      }
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-delete', errorMessage(error));
    }
  }

  function commitUnitName(unit: ScenarioDocument, raw: string) {
    try {
      onChange(updateUnitName(document, unit?.id, raw));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-name', errorMessage(error));
    }
  }

  function commitUnitSide(unit: ScenarioDocument, sideId: string) {
    if (sideId === unit?.side) return;
    try {
      onChange(updateUnitSide(document, unit?.id, sideId));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-side', errorMessage(error));
    }
  }

  // Changing the troop type pre-fills both spacings from the new type's
  // normal preset in the same undo step; the scenario stores the metres
  // (ADR 0002), never the preset itself.
  function commitUnitTroopType(unit: ScenarioDocument, troopType: string) {
    if (troopType === unit?.troopType) return;
    try {
      const preset = (getTroopType(troopType) as any)?.presets?.normal ?? null;
      onChange(updateUnitTroopType(document, unit?.id, troopType, preset));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-troop', errorMessage(error));
    }
  }

  function commitUnitNumbers(unit: ScenarioDocument, patch: { soldiers?: string; files?: string }) {
    const field = patch.soldiers !== undefined ? 'unit-soldiers' : 'unit-files';
    const label = patch.soldiers !== undefined ? 'Soldiers' : 'Files';
    const trimmed = String(patch.soldiers ?? patch.files ?? '').trim();
    if (!trimmed || !Number.isInteger(Number(trimmed)) || Number(trimmed) < 1) {
      fail(field, `${label} must be a whole number of at least 1.`);
      return;
    }
    try {
      onChange(
        updateUnitNumbers(document, unit?.id, {
          ...(patch.soldiers !== undefined ? { soldiers: Number(trimmed) } : {}),
          ...(patch.files !== undefined ? { files: Number(trimmed) } : {}),
        }),
      );
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail(field, errorMessage(error));
    }
  }

  function commitUnitSpacing(
    unit: ScenarioDocument,
    key: 'lateralInterval' | 'rankDepth',
    raw: string,
  ) {
    const label = key === 'lateralInterval' ? 'Lateral interval' : 'Rank depth';
    const field = key === 'lateralInterval' ? 'unit-spacing-lateral' : 'unit-spacing-depth';
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      fail(field, `${label} must be a positive number of metres.`);
      return;
    }
    try {
      onChange(updateUnitSpacing(document, unit?.id, { [key]: Number(trimmed) }));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail(field, errorMessage(error));
    }
  }

  // A spacing preset pre-fills both spacings in metres in one undo step.
  function commitUnitPreset(unit: ScenarioDocument, presetKey: string) {
    if (presetKey === 'custom') return;
    const preset = (getTroopType(unit?.troopType) as any)?.presets?.[presetKey];
    if (!preset) return;
    try {
      onChange(updateUnitSpacing(document, unit?.id, preset));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-preset', errorMessage(error));
    }
  }

  return { presetKeyFor, handleAddUnit, handleDuplicateUnit, handleDeleteUnit, commitUnitName, commitUnitSide, commitUnitTroopType, commitUnitNumbers, commitUnitSpacing, commitUnitPreset };
}
