export function scenarioIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('scenario');
  return id && id.trim() ? id : null;
}

export function battleIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('battle');
  return id && id.trim() ? id : null;
}

// The seed is drawn at Begin and never shown: there is no seed field in the
// UI. Tests fix it programmatically through `window.__POLIS_TEST_SEED` or
// the `?seed=` query parameter.
export function battleSeedOverride(): string | number | null {
  if (typeof window === 'undefined') return null;
  const programmatic = (window as any).__POLIS_TEST_SEED;
  if (typeof programmatic === 'number' || typeof programmatic === 'string') {
    return programmatic;
  }
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null || raw.trim() === '') return null;
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

export function drawBattleSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0];
}

export function setUrlParams(params: { scenario?: string | null; battle?: string | null }) {
  const url = new URL(window.location.href);
  if (params.scenario === undefined) {
    // Leave untouched.
  } else if (params.scenario) {
    url.searchParams.set('scenario', params.scenario);
  } else {
    url.searchParams.delete('scenario');
  }
  if (params.battle === undefined) {
    // Leave untouched.
  } else if (params.battle) {
    url.searchParams.set('battle', params.battle);
  } else {
    url.searchParams.delete('battle');
  }
  window.history.replaceState(null, '', url);
}

export function downloadFile(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Quota failures never lose work: the store save is atomic, so the previous
// version is intact and the author keeps the same unsaved changes.
export function quotaFailureMessage(what: string): string {
  return (
    `${what} failed: browser storage is full (quota exceeded). ` +
    'The previous version is intact; your changes are still here.'
  );
}
