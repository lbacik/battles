import { escapeXml } from './map-helpers';

// Scene helpers for `BattlefieldSvg`: fills, metres-per-pixel and the
// string builders for ghost/path, conflict-marker and terrain layers.
// Pure and framework-free; `BattlefieldSvg` memoises them per render.
export const GROUND_FILLS: Record<string, { fill: string; stroke: string; label: string }> = {
  forest: { fill: '#aebc9c', stroke: '#93a582', label: 'Forest' },
  rough: { fill: '#d8d2b8', stroke: '#a89f83', label: 'Rough ground' },
  water: { fill: '#b3cece', stroke: '#92b2b0', label: 'Water' },
  settlement: { fill: '#d8cbb2', stroke: '#a08c66', label: 'Settlement' },
};

// Rivers and roads draw as true-scale polylines: the stroke width is the
// stored width in metres, so what is drawn is what counts.
export const LINEAR_COLORS: Record<string, string> = {
  river: '#7fb3c8',
  road: '#c9b98f',
};

export const LINEAR_LABELS: Record<string, string> = {
  river: 'River',
  road: 'Road',
};


export function mppOf(placed: any[]): number {
  return placed.length > 0 && Number.isFinite(placed[0].mpp) ? placed[0].mpp : 1;
}

export function buildBattleOverlays(args: {
  battleGhosts: any;
  battlePaths: any;
  battleShootLines: any;
  safeH: number;
  mpp: number;
}): string {
  const { battleGhosts, battlePaths, battleShootLines, safeH, mpp } = args;
    let out = '';
    for (const ghost of battleGhosts) {
      if (!ghost || !Array.isArray(ghost.corners) || ghost.corners.length < 3) {
        continue;
      }
      const line = ghost.corners.map((point: any) => `${point.x},${safeH - point.y}`).join(' ');
      const kindLabel = ghost.kind ? escapeXml(ghost.kind) : 'Move';
      out += `<polygon points="${line}" fill="#4e6047" fill-opacity="0.14" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="draft-ghost" data-ghost-unit="${escapeXml(ghost.unitId)}"><title>Ghost: ${escapeXml(ghost.unitId)} ${kindLabel} preview</title></polygon>`;
    }
    for (const path of battlePaths) {
      const points = Array.isArray(path?.points) ? path.points : [];
      if (points.length < 2) {
        continue;
      }
      const line = points.map((point: any) => `${point.x},${safeH - point.y}`).join(' ');
      const color = path.rejected ? '#b91c1c' : '#4e6047';
      const dash = path.rejected
        ? `${(3 * mpp).toFixed(1)} ${(3 * mpp).toFixed(1)}`
        : `${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}`;
      out += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${dash}" data-testid="draft-path"><title>${escapeXml(path.label || 'Leg')}</title></polyline>`;
      out += points
        .slice(1)
        .map(
          (stop: any, legIndex: number) =>
            `<circle cx="${stop.x}" cy="${(safeH - stop.y).toFixed(1)}" r="${(5 * mpp).toFixed(2)}" fill="${color}" stroke="#f8f9f0" stroke-width="${(1.5 * mpp).toFixed(2)}" data-testid="draft-vertex"><title>${escapeXml(path.label || 'Leg')} ${legIndex + 1} · (${stop.x.toFixed(1)}, ${stop.y.toFixed(1)})</title></circle>`,
        )
        .join('');
    }
    // A Shoot never moves: the line marks the shot, and the Shooting phase
    // resolves it. Rejected shots draw in red like every rejected draft.
    for (const shot of battleShootLines) {
      if (!shot || !shot.from || !shot.to) {
        continue;
      }
      const color = shot.rejected ? '#b91c1c' : '#2f6f8f';
      out += `<line x1="${shot.from.x}" y1="${safeH - shot.from.y}" x2="${shot.to.x}" y2="${safeH - shot.to.y}" stroke="${color}" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="shoot-line"><title>Shoot: ${escapeXml(shot.shooterId)} → ${escapeXml(shot.targetId)}</title></line>`;
    }
    return out;
}

export function buildBattleMarkers(args: { battleConflictPoints: any; safeH: number; mpp: number }): string {
  const { battleConflictPoints, safeH, mpp } = args;
    let out = '';
    for (const point of battleConflictPoints) {
      if (!point || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        continue;
      }
      out += `<circle cx="${point.x}" cy="${safeH - point.y}" r="${(8 * mpp).toFixed(2)}" fill="none" stroke="#b91c1c" stroke-width="${(2.5 * mpp).toFixed(2)}" data-testid="conflict-marker"><title>Conflict at (${point.x.toFixed(1)}, ${point.y.toFixed(1)})</title></circle>`;
    }
    return out;
}

export function buildTerrainLayer(args: {
  terrainFeatures: any;
  selectedTerrainId: any;
  selectedVertexIndex: any;
  draft: any;
  refusal: any;
  showContours: any;
  safeH: number;
  zoom: number;
  mpp: number;
}): string {
  const {
    terrainFeatures,
    selectedTerrainId,
    selectedVertexIndex,
    draft,
    refusal,
    showContours,
    safeH,
    zoom,
    mpp,
  } = args;
    const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];
    const project = (points: any[]) =>
      points
        .map((point) => `${point.x},${safeH - point.y}`)
        .join(' ');
    let out = '';
    for (const feature of features) {
      if (!feature) {
        continue;
      }
      // A river or road is an open polyline drawn at true scale: the stroke
      // width is the stored width in metres, so the line covers exactly the
      // ground it claims. Rivers and roads may cross everything, so they are
      // never in conflict with another feature.
      if (feature.kind === 'linear') {
        if (!Array.isArray(feature.path) || feature.path.length < 2) {
          continue;
        }
        const line = project(feature.path as any[]);
        const id = escapeXml(String(feature.id ?? ''));
        const selected = feature.id === selectedTerrainId;
        const color = LINEAR_COLORS[feature.category] || '#888888';
        const widthM = Number(feature.width);
        const label = `${LINEAR_LABELS[feature.category] || 'River or road'} · ${escapeXml(String(feature.width))} m`;
        const halo = selected
          ? `<polyline points="${line}" fill="none" stroke="#4e6047" stroke-width="${(Number.isFinite(widthM) ? widthM : 0) + 6 * mpp}" opacity="0.35" stroke-linecap="round" stroke-linejoin="round" class="terrain-linear-halo"/>`
          : '';
        out += `${halo}<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${Number.isFinite(widthM) ? widthM : 2}" stroke-linecap="round" stroke-linejoin="round" data-feature-id="${id}" data-testid="terrain-linear"><title>${label}</title></polyline>`;
        continue;
      }
      if (feature.kind !== 'ground' && feature.kind !== 'elevation') {
        continue;
      }
      if (!Array.isArray(feature.polygon) || feature.polygon.length < 3) {
        continue;
      }
      const ring = feature.polygon as any[];
      const line = project(ring);
      const id = escapeXml(String(feature.id ?? ''));
      const selected = feature.id === selectedTerrainId;
      const conflict =
        refusal?.conflictId !== undefined &&
        refusal?.conflictId !== null &&
        feature.id === refusal.conflictId;
      const screen = ring.map((point) => ({ x: point.x, y: safeH - point.y }));
      const cx = screen.reduce((sum, point) => sum + point.x, 0) / screen.length;
      const cy = screen.reduce((sum, point) => sum + point.y, 0) / screen.length;
      const selectedHalo = selected
        ? `<polygon points="${line}" fill="none" stroke="#9b7538" stroke-width="3" stroke-dasharray="7 5"/>`
        : '';
      if (feature.kind === 'ground') {
        const style = GROUND_FILLS[feature.category] || {
          fill: '#cccccc',
          stroke: '#999999',
          label: String(feature.category || 'Ground cover'),
        };
        const outline = conflict ? '#b76e5a' : style.stroke;
        let art = `<polygon points="${line}" fill="${style.fill}" fill-opacity="0.85" stroke="${outline}" stroke-width="${selected || conflict ? 3 : 1.5}"><title>${escapeXml(style.label)} area</title></polygon>`;
        if (feature.category === 'forest') {
          const minX = Math.min(...screen.map((point) => point.x));
          const maxX = Math.max(...screen.map((point) => point.x));
          const minY = Math.min(...screen.map((point) => point.y));
          const maxY = Math.max(...screen.map((point) => point.y));
          let trees = '';
          for (let y = minY + 10; y < maxY; y += 21) {
            for (let x = minX + 10; x < maxX; x += 22) {
              const ox = Math.sin(x + y) * 5;
              const oy = Math.cos(x * y) * 5;
              trees += `<use href="#polis-tree" x="${(x + ox).toFixed(1)}" y="${(y + oy).toFixed(1)}" opacity="${(0.55 + 0.2 * Math.sin(x)).toFixed(2)}"/>`;
            }
          }
          art += `<defs><clipPath id="clip-${id}"><polygon points="${line}"/></clipPath></defs><g clip-path="url(#clip-${id})">${trees}</g>`;
        } else if (feature.category === 'rough') {
          art = `<polygon points="${line}" fill="url(#polis-rough)" stroke="${conflict ? '#b76e5a' : '#b5ab93'}" stroke-width="${selected || conflict ? 3 : 1.5}"><title>Rough ground area</title></polygon>`;
        } else if (feature.category === 'water') {
          art += `<polygon points="${line}" fill="url(#polis-water)"><title>Water area</title></polygon>`;
        } else if (feature.category === 'settlement') {
          let houses = '';
          for (let row = 0; row < 3; row += 1) {
            for (let col = 0; col < 3; col += 1) {
              const hx = cx + (col - 1) * 34 + (row % 2) * 7;
              const hy = cy + (row - 1) * 27;
              const tilt = (col + row) % 2 === 0 ? 12 : -10;
              houses += `<g transform="translate(${hx.toFixed(1)} ${hy.toFixed(1)}) rotate(${tilt})"><rect x="-12" y="-7" width="26" height="19" fill="#a69a7c" opacity=".2"/><rect x="-13" y="-11" width="24" height="16" fill="#c6b89e" stroke="#9b8c73"/><path d="m-15-11 14-8 15 8-14 7z" fill="#b68e6f" stroke="#a08263" stroke-width=".7"/></g>`;
            }
          }
          art += `<defs><clipPath id="clip-${id}"><polygon points="${line}"/></clipPath></defs><g clip-path="url(#clip-${id})"><path d="M${(cx - 65).toFixed(1)},${(cy + 40).toFixed(1)}l140,-70M${(cx - 30).toFixed(1)},${(cy - 65).toFixed(1)}l55,125" fill="none" stroke="#c1b699" stroke-width="8"/>${houses}</g>`;
        }
        out += `<g data-feature-id="${id}" data-testid="terrain-ground">${art}${selectedHalo}</g>`;
      } else {
        const level = feature.level;
        const outline = conflict ? '#b76e5a' : '#8a7a5c';
        let rings = '';
        if (showContours) {
          for (let i = 0; i < 6; i += 1) {
            const scale = 1 - i * 0.135;
            rings += `<polygon points="${line}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${scale.toFixed(3)}) translate(${(-cx).toFixed(1)} ${(-cy).toFixed(1)})" fill="${i === 5 ? '#b7bc93' : 'none'}" fill-opacity=".22" stroke="#a8ad85" stroke-width="1.2" opacity="${(0.5 + i * 0.06).toFixed(2)}"/>`;
          }
        }
        out += `<g data-feature-id="${id}" data-testid="terrain-hill"><polygon points="${line}" fill="#c6c8a4" fill-opacity=".31" stroke="${outline}" stroke-width="${selected || conflict ? 3 : 1.5}" stroke-dasharray="7 4"><title>Hill · level ${escapeXml(String(level))} (derived from nesting)</title></polygon>${rings}<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="${(13 / zoom).toFixed(2)}" fill="#6b6247" pointer-events="none">L${escapeXml(String(level))}</text>${selectedHalo}</g>`;
      }
    }
    if (refusal && Array.isArray(refusal.ring) && refusal.ring.length >= 2) {
      const label = escapeXml(refusal.reason || 'Refused shape');
      // A refused river or road is an open line, never a closed shape.
      if (refusal.kind === 'linear' || refusal.ring.length === 2) {
        out += `<polyline points="${project(refusal.ring)}" fill="none" stroke="#b76e5a" stroke-width="${(2.5 * mpp).toFixed(2)}" stroke-dasharray="${(8 * mpp).toFixed(1)} ${(5 * mpp).toFixed(1)}" class="terrain-refused" data-testid="terrain-refusal-shape"><title>${label}</title></polyline>`;
      } else {
        out += `<polygon points="${project(refusal.ring)}" fill="#b76e5a" fill-opacity="0.35" stroke="#b76e5a" stroke-width="${(2.5 * mpp).toFixed(2)}" stroke-dasharray="${(8 * mpp).toFixed(1)} ${(5 * mpp).toFixed(1)}" class="terrain-refused" data-testid="terrain-refusal-shape"><title>${label}</title></polygon>`;
      }
    }
    if (draft && Array.isArray(draft.points) && draft.points.length > 0) {
      const line = project(draft.points);
      const isLinearDraft = draft.kind === 'linear';
      const fill =
        !isLinearDraft && draft.points.length >= 3
          ? `<polygon points="${line}" fill="#4e6047" fill-opacity="0.12" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="terrain-draft"/>`
          : `<polyline points="${line}" fill="none" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="terrain-draft"/>`;
      out +=
        fill +
        draft.points
          .map((point: any) => {
            const sx = point.x;
            const sy = safeH - point.y;
            return `<circle cx="${sx}" cy="${sy}" r="${(5 * mpp).toFixed(2)}" fill="#4e6047" stroke="#f4f3e9" stroke-width="${(1.5 * mpp).toFixed(2)}" class="terrain-draft-vertex"/>`;
          })
          .join('');
    }
    const selected = features.find(
      (feature) =>
        feature?.id === selectedTerrainId &&
        (((feature.kind === 'ground' || feature.kind === 'elevation') &&
          Array.isArray(feature.polygon) &&
          feature.polygon.length >= 3) ||
          (feature.kind === 'linear' &&
            Array.isArray(feature.path) &&
            feature.path.length >= 2)),
    );
    if (selected && !draft) {
      const isLinear = selected.kind === 'linear';
      const ring = (isLinear ? selected.path : selected.polygon) as any[];
      const handleStroke = isLinear ? '#7fa8c9' : '#4e6047';
      // Edges of a river or road run between consecutive vertices only; a
      // polygon's last edge wraps back to its first vertex.
      const edges = isLinear ? ring.length - 1 : ring.length;
      for (let index = 0; index < edges; index += 1) {
        const point = ring[index];
        const edge = ring[(index + 1) % ring.length];
        const mid = { x: (point.x + edge.x) / 2, y: (point.y + edge.y) / 2 };
        out += `<circle cx="${mid.x.toFixed(1)}" cy="${(safeH - mid.y).toFixed(1)}" r="${(4 * mpp).toFixed(2)}" fill="#faf9f4" stroke="${handleStroke}" stroke-width="${(1.5 * mpp).toFixed(2)}" stroke-dasharray="${(3 * mpp).toFixed(1)} ${(2 * mpp).toFixed(1)}" class="terrain-edge-handle" data-testid="terrain-edge-handle" data-edge-index="${index}" data-feature-id="${escapeXml(String(selected.id))}"><title>Insert a vertex here</title></circle>`;
      }
      out += ring
        .map((point, index) => {
          const active = index === selectedVertexIndex;
          return `<circle cx="${point.x}" cy="${safeH - point.y}" r="${((active ? 7 : 6) * mpp).toFixed(2)}" fill="${active ? handleStroke : '#faf9f4'}" stroke="${handleStroke}" stroke-width="${(2 * mpp).toFixed(2)}" class="terrain-vertex${active ? ' selected' : ''}" data-testid="terrain-vertex-handle" data-vertex-index="${index}" data-feature-id="${escapeXml(String(selected.id))}"><title>Vertex ${index + 1}: drag to move, Delete removes it</title></circle>`;
        })
        .join('');
    }
    return out;
}
