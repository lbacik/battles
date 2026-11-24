// PÓLIS domain core — the complete scenario model, structural validation,
// and file exchange (framework-free).
//
// This module is the framework-free domain package: it imports nothing —
// no React, no Next.js, no DOM, no Node APIs — so it runs unchanged in the
// browser editor, in Node unit tests, and in any future shell. Geometry
// helpers live in `./geometry.js`; the provisional ruleset catalogue lives
// in `./polis-classical.js` and is never consulted here (catalogue
// membership is a playability concern, not a structural one).
//
// Map convention (ADR 0001): the battlefield uses a map convention with the
// origin at the south-west corner, x east, y north, measured in metres.
// Stored values are rounded to 0.1 m. Only rendering flips the vertical
// axis for the screen (see toScreenPoint).
//
// Scenario document (format version 1):
//   kind, formatVersion, id, title, description,
//   battlefield { width, height },
//   sides [exactly two: { id, name, color }],
//   ruleset { id, version },
//   units [{ id, name, side, troopType, soldiers, files,
//             lateralInterval, rankDepth, position { x, y }, facing }],
//   terrainFeatures [{ id, kind, ... }],
//   createdAt, updatedAt.
// A unit's position is the midpoint of its front edge; facing is a compass
// bearing in degrees (0 = north, clockwise). Terrain features are ground
// cover polygons (kind 'ground', category forest | rough | water |
// settlement; open ground is the default and needs no feature), elevation
// level polygons (kind 'elevation', level >= 1, nesting derived from
// containment), and linear features (kind 'linear', category river | road,
// path polyline plus width in metres).
export { SCENARIO_KIND, SCENARIO_FORMAT_VERSION, RULESET_ID, RULESET_VERSION, MAX_BATTLEFIELD_WIDTH_M, MAX_BATTLEFIELD_HEIGHT_M, DEFAULT_BATTLEFIELD, MAX_SPACING_M, DEFAULT_SIDES, GROUND_COVER_CATEGORIES, LINEAR_FEATURE_CATEGORIES, KNOWN_RULESET_IDS, generateId, isUuid, cloneScenario, scenarioContentEquals } from './scenario/document.js';
export { roundScenarioToTenth, valuesOffTenthGrid } from './scenario/rounding.js';
export { validateScenario, isValidScenario, assertValidScenario, collectWarnings } from './scenario/validation.js';
export { createScenario, clipTerrainFeatureToBounds, resizeBattlefield, updateScenarioTitle, updateScenarioDescription, updateSideName, updateSideColor } from './scenario/properties.js';
export { validateGroundCoverCandidate, addGroundCoverFeature, updateGroundCoverFeature, removeGroundCoverFeature, validateElevationCandidate, addElevationFeature, updateElevationFeature, removeElevationFeature, validateLinearCandidate, addLinearFeature, updateLinearFeature, removeLinearFeature } from './scenario/terrain.js';
export { ScenarioImportError, scenarioFileName, exportScenario, parseScenarioImport, importScenarioDocument } from './scenario/exchange.js';
export { toScreenPoint, fromScreenPoint, fitScale, MAP_VIEW_MIN_ZOOM, MAP_VIEW_MAX_ZOOM, MAP_VIEW_PAD_LEFT_M, MAP_VIEW_PAD_RIGHT_M, MAP_VIEW_PAD_TOP_M, MAP_VIEW_PAD_BOTTOM_M, clampMapZoom, fitMapView, zoomViewAroundCursor, panMapViewByPixels, mapViewBox, metresPerPixel, niceScaleBarMetres } from './scenario/view.js';
export { unitPosition, unitFacingDeg, unitFootprint, isProvisionalRulesetVersion, isProvisionalRuleset, compareRulesetVersions, classifyRulesetReference, isOpenableRulesetReference, rulesetCompatibilityNotice, rebindRulesetToCurrent, suggestUnitName, defaultFacingForSide } from './scenario/ruleset.js';
export { UNIT_PICK_TOLERANCE_PX, FACING_SNAP_DEG, normalizeFacing, snapFacing, footprintCorners, footprintHitTest, pickUnitIdAtPoint, unitsBlockingResize, proposeUnitPatch, unitDerived, createUnit, duplicateUnit, deleteUnit, updateUnitName, updateUnitSide, updateUnitTroopType, updateUnitNumbers, updateUnitSpacing, findFreeUnitPosition } from './scenario/units.js';
export { createHistory, historyCommit, historyUndo, historyRedo } from './scenario/history.js';
export { deriveFootprint } from './geometry.js';
