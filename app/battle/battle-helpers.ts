type BattleDocument = any;

export function sideOf(battle: BattleDocument, id: string): any {
  return (battle?.scenario?.sides || []).find((side: any) => side?.id === id) || null;
}

export function sideName(battle: BattleDocument, id: string): string {
  return sideOf(battle, id)?.name || id;
}

export function sideColor(battle: BattleDocument, id: string): string {
  return sideOf(battle, id)?.color || '#666666';
}

export function roundLimitOf(battle: BattleDocument): number {
  const limit = battle?.parameters?.battle?.roundLimit;
  return Number.isInteger(limit) && limit > 0 ? limit : 12;
}

export function isAutomatedController(controller: unknown): boolean {
  return controller !== 'human';
}
