// Shared fixtures for the scenario domain tests (framework-free).
//
// These helpers live beside the scenario tests; they import only the public
// scenario entry point.
import { createScenario, generateId } from '../scenario.js';

export const freshDocument = () => createScenario({ title: 'Validation probe' });

export const probeUnit = (overrides = {}) => ({
  id: generateId(),
  name: 'Probe taxis',
  side: 'side-a',
  troopType: 'hoplite',
  soldiers: 100,
  files: 10,
  lateralInterval: 1,
  rankDepth: 1,
  position: { x: 600, y: 400 },
  facing: 0,
  ...overrides,
});

export const square = (x, y, size = 100) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];
