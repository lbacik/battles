// PÓLIS domain core — plane geometry helpers (framework-free).
//
// The battlefield is a continuous 2D plane measured in metres (ADR 0001):
// the origin sits at the south-west corner, x points east, y points north,
// and facing is a compass bearing in degrees (0 = north, clockwise). This
// module imports nothing, so it runs unchanged in the browser editor, in
// Node unit tests, and in any future shell.

export const METRE_ROUNDING = 0.1;

// Comparison epsilon for coordinate arithmetic. Stored values are rounded
// to 0.1 m; this epsilon only absorbs floating-point noise, never design
// tolerance (the 0.1 m footprint-overlap tolerance is applied explicitly
// by shrinking footprints, not by widening this epsilon).
const EPS = 1e-9;

// Round a metre value to the stored precision of 0.1 m.
export function round1(value) {
  return Math.round(value * 10) / 10;
}

function isFinitePoint(point) {
  return (
    !!point &&
    typeof point === 'object' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

// Footprint derivation (ADR 0002): ranks = ceil(soldiers / files),
// frontage = files x lateral interval, depth = ranks x rank depth. The
// footprint is anchored at the front midpoint and rotates about it: the
// front edge midpoint is exactly the unit position, and depth extends
// backwards from the front. Corners are returned in order:
// front-left, front-right, rear-right, rear-left (from the unit's own
// perspective, i.e. left and right of the facing direction).
export function deriveFootprint(unit) {
  const ranks = Math.ceil(unit.soldiers / unit.files);
  const frontage = unit.files * unit.lateralInterval;
  const depth = ranks * unit.rankDepth;
  const radians = (unit.facing * Math.PI) / 180;
  const forwardX = Math.sin(radians);
  const forwardY = Math.cos(radians);
  const rightX = Math.cos(radians);
  const rightY = -Math.sin(radians);
  const half = frontage / 2;
  const frontLeft = {
    x: unit.position.x - rightX * half,
    y: unit.position.y - rightY * half,
  };
  const frontRight = {
    x: unit.position.x + rightX * half,
    y: unit.position.y + rightY * half,
  };
  return {
    ranks,
    frontage,
    depth,
    corners: [
      frontLeft,
      frontRight,
      { x: frontRight.x - forwardX * depth, y: frontRight.y - forwardY * depth },
      { x: frontLeft.x - forwardX * depth, y: frontLeft.y - forwardY * depth },
    ],
  };
}

// Same footprint derivation with the rectangle shrunk by the given total
// margin (removed evenly from every side). Structural validation shrinks
// each footprint by METRE_ROUNDING (0.1 m) before the overlap test, so an
// overlap shallower than 0.1 m is tolerated while touching stays legal.
// Returns null when the unit is too small to shrink.
export function shrinkFootprint(unit, margin = METRE_ROUNDING) {
  const derived = deriveFootprint(unit);
  const frontage = derived.frontage - margin;
  const depth = derived.depth - margin;
  if (!(frontage > 0) || !(depth > 0)) {
    return null;
  }
  const eachSide = margin / 2;
  const radians = (unit.facing * Math.PI) / 180;
  const forwardX = Math.sin(radians);
  const forwardY = Math.cos(radians);
  // Move the front edge backwards by half the margin so the shrink is even.
  const anchor = {
    x: unit.position.x - forwardX * eachSide,
    y: unit.position.y - forwardY * eachSide,
  };
  return deriveFootprint({
    soldiers: unit.soldiers,
    files: unit.files,
    lateralInterval: frontage / unit.files,
    rankDepth: depth / derived.ranks,
    position: anchor,
    facing: unit.facing,
  });
}

// Signed polygon area (positive for counter-clockwise rings).
export function signedPolygonArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonArea(ring) {
  return Math.abs(signedPolygonArea(ring));
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a, b, point) {
  return (
    Math.min(a.x, b.x) - EPS <= point.x &&
    point.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= point.y &&
    point.y <= Math.max(a.y, b.y) + EPS &&
    Math.abs(orientation(a, b, point)) <= EPS
  );
}

// Strict crossing: the segments pass through each other. Touches at
// endpoints, or a vertex resting on an edge, are not crossings.
export function segmentsProperlyCross(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function segmentsIntersect(a, b, c, d) {
  if (segmentsProperlyCross(a, b, c, d)) {
    return true;
  }
  return (
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
  );
}

function edgeOf(ring, index) {
  return [ring[index], ring[(index + 1) % ring.length]];
}

// A polygon is simple when its edges meet only at consecutive vertices:
// no self-intersection, no spikes doubling back, no duplicate points.
export function isSimplePolygon(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }
  if (!ring.every(isFinitePoint)) {
    return false;
  }
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const [a, b] = edgeOf(ring, i);
    if (Math.hypot(b.x - a.x, b.y - a.y) <= EPS) {
      return false;
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const [a, b] = edgeOf(ring, i);
      const [c, d] = edgeOf(ring, j);
      if (adjacent) {
        // Consecutive edges share exactly one endpoint; anything more
        // (a spike folding back along the same line) is not simple.
        if (onSegment(a, b, c) && (Math.abs(c.x - a.x) > EPS || Math.abs(c.y - a.y) > EPS) && (Math.abs(c.x - b.x) > EPS || Math.abs(c.y - b.y) > EPS)) {
          return false;
        }
        if (onSegment(a, b, d) && (Math.abs(d.x - a.x) > EPS || Math.abs(d.y - a.y) > EPS) && (Math.abs(d.x - b.x) > EPS || Math.abs(d.y - b.y) > EPS)) {
          return false;
        }
        continue;
      }
      if (segmentsIntersect(a, b, c, d)) {
        return false;
      }
    }
  }
  return true;
}

// Point location against a ring: 'inside', 'outside', or 'boundary'.
export function locatePoint(ring, point) {
  for (let i = 0; i < ring.length; i += 1) {
    const [a, b] = edgeOf(ring, i);
    if (onSegment(a, b, point)) {
      return 'boundary';
    }
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > point.y !== b.y > point.y) {
      const x = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (point.x < x) {
        inside = !inside;
      }
    }
  }
  return inside ? 'inside' : 'outside';
}

// True when the two simple polygons share a positive area. Touching along
// an edge or at a point is not an overlap.
export function polygonsOverlapPositiveArea(ringA, ringB) {
  for (let i = 0; i < ringA.length; i += 1) {
    const [a, b] = edgeOf(ringA, i);
    for (let j = 0; j < ringB.length; j += 1) {
      const [c, d] = edgeOf(ringB, j);
      if (segmentsProperlyCross(a, b, c, d)) {
        return true;
      }
    }
  }
  if (ringA.some((point) => locatePoint(ringB, point) === 'inside')) {
    return true;
  }
  if (ringB.some((point) => locatePoint(ringA, point) === 'inside')) {
    return true;
  }
  // No proper crossing and no vertex strictly inside: the only remaining
  // overlap shape is full containment with every vertex on the boundary
  // (identical rings) or an overlap flush against a shared edge. Probe just
  // inside each edge: an interior sample inside the other ring means overlap.
  const probes = [ringA, ringB];
  for (let k = 0; k < probes.length; k += 1) {
    const ring = probes[k];
    const other = k === 0 ? ringB : ringA;
    const ccw = signedPolygonArea(ring) > 0;
    for (let i = 0; i < ring.length; i += 1) {
      const [a, b] = edgeOf(ring, i);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length <= EPS) {
        continue;
      }
      // Interior normal: left of the edge for CCW rings, right for CW.
      const nx = ccw ? -dy / length : dy / length;
      const ny = ccw ? dx / length : -dx / length;
      const sample = {
        x: (a.x + b.x) / 2 + nx * 1e-4,
        y: (a.y + b.y) / 2 + ny * 1e-4,
      };
      if (locatePoint(other, sample) === 'inside') {
        return true;
      }
    }
  }
  return false;
}

// True when every vertex of `inner` lies inside `outer` or on its boundary
// and no edges cross: `inner` is wholly inside `outer` (boundary contact
// counts as inside for terrain nesting).
export function polygonInsideOrOn(inner, outer) {
  if (!inner.every((point) => locatePoint(outer, point) !== 'outside')) {
    return false;
  }
  for (let i = 0; i < inner.length; i += 1) {
    const [a, b] = edgeOf(inner, i);
    for (let j = 0; j < outer.length; j += 1) {
      const [c, d] = edgeOf(outer, j);
      if (segmentsProperlyCross(a, b, c, d)) {
        return false;
      }
    }
  }
  return true;
}

export function pointsWithinBounds(points, width, height) {
  return points.every(
    (point) =>
      isFinitePoint(point) &&
      point.x >= -EPS &&
      point.x <= width + EPS &&
      point.y >= -EPS &&
      point.y <= height + EPS,
  );
}

// --- Clipping to the battlefield bounds ------------------------------------
// Used when the battlefield shrinks: terrain geometry overlapping the new
// bounds is clipped to them instead of refusing the resize. Clipping every
// feature to the same rectangle preserves containment, so nested elevation
// stays nested and disjoint ground cover stays disjoint. Features left empty
// or degenerate by the clip are dropped by the caller.

// Remove consecutive duplicate points (and a repeated closing point) so
// clipped rings stay simple. Exported for unit tests; the clip functions
// dedupe their own output internally.
export function dedupePoints(points) {
  const clean = [];
  for (const point of points) {
    const last = clean[clean.length - 1];
    if (
      !last ||
      Math.abs(last.x - point.x) > EPS ||
      Math.abs(last.y - point.y) > EPS
    ) {
      clean.push({ x: point.x, y: point.y });
    }
  }
  if (clean.length > 1) {
    const [first] = clean;
    const last = clean[clean.length - 1];
    if (Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS) {
      clean.pop();
    }
  }
  return clean;
}

// Clip a polygon ring to the rectangle [0, width] x [0, height] with the
// Sutherland-Hodgman algorithm. A fully outside ring clips to an empty ring;
// a fully inside ring keeps its vertices. The rectangle is convex, so the
// clip of a simple ring stays simple.
export function clipPolygonToRect(ring, width, height) {
  if (!Array.isArray(ring) || ring.length === 0) {
    return [];
  }
  const bounds = [
    {
      inside: (point) => point.x >= 0,
      cross: (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) }),
    },
    {
      inside: (point) => point.x <= width,
      cross: (a, b) => ({
        x: width,
        y: a.y + ((b.y - a.y) * (width - a.x)) / (b.x - a.x),
      }),
    },
    {
      inside: (point) => point.y >= 0,
      cross: (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 }),
    },
    {
      inside: (point) => point.y <= height,
      cross: (a, b) => ({
        x: a.x + ((b.x - a.x) * (height - a.y)) / (b.y - a.y),
        y: height,
      }),
    },
  ];
  let output = ring.map((point) => ({ x: point.x, y: point.y }));
  for (const bound of bounds) {
    const input = output;
    output = [];
    if (input.length === 0) {
      break;
    }
    let start = input[input.length - 1];
    for (const end of input) {
      const endInside = bound.inside(end);
      const startInside = bound.inside(start);
      if (endInside) {
        if (!startInside) {
          output.push(bound.cross(start, end));
        }
        output.push(end);
      } else if (startInside) {
        output.push(bound.cross(start, end));
      }
      start = end;
    }
  }
  return dedupePoints(output);
}

// Clamp a polyline path into the rectangle [0, width] x [0, height].
// Clamping (rather than splitting at the boundary) keeps the feature a
// single path: a stretch running outside and back follows the boundary.
// Points collapsing onto each other are removed; the caller drops a path
// left with fewer than two points.
export function clipPathToRect(path, width, height) {
  if (!Array.isArray(path) || path.length === 0) {
    return [];
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  return dedupePoints(
    path.map((point) => ({
      x: clamp(point.x, 0, width),
      y: clamp(point.y, 0, height),
    })),
  );
}
