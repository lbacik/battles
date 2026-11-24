import {
  classifyRulesetReference,
  cloneScenario,
  createHistory,
  createScenario,
  exportScenario,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  rebindRulesetToCurrent,
  validateScenario,
} from '../../domain/scenario.js';
import {
  SaveConflictError,
  duplicateScenario,
  exportRawRecord,
  isQuotaError,
  isUnsupportedDocument,
  performSave,
} from '../../domain/library.js';
import { documentsMatch, getScenarioStore, type LibraryEntry } from '../../lib/store';
import { downloadFile, quotaFailureMessage } from './page-helpers';

type ScenarioDocument = any;

// Actions that read or write the scenario library and the open editing
// session. State stays in `Home`; this factory only closes over the values
// and setters `Home` passes in each render, so behaviour is unchanged.
export interface ScenarioActionsDeps {
  creating: any;
  setCreating: (next: any) => void;
  error: any;
  setError: (next: any) => void;
  openId: any;
  setOpenId: (next: any) => void;
  document: any;
  setDocument: (next: any) => void;
  savedDocument: any;
  setSavedDocument: (next: any) => void;
  history: any;
  setHistory: (next: any) => void;
  revision: any;
  setRevision: (next: any) => void;
  saveError: any;
  setSaveError: (next: any) => void;
  saving: any;
  setSaving: (next: any) => void;
  conflict: any;
  setConflict: (next: any) => void;
  importError: any;
  setImportError: (next: any) => void;
  dirty: any;
  closeEditor: (...args: any[]) => any;
  refreshLibrary: (...args: any[]) => any;
  ensurePersistenceOnce: (...args: any[]) => any;
  openScenario: (...args: any[]) => any;
  showToast: (...args: any[]) => any;
}

export function createScenarioActions(deps: ScenarioActionsDeps) {
  const {
    creating,
    setCreating,
    error,
    setError,
    openId,
    setOpenId,
    document,
    setDocument,
    savedDocument,
    setSavedDocument,
    history,
    setHistory,
    revision,
    setRevision,
    saveError,
    setSaveError,
    saving,
    setSaving,
    conflict,
    setConflict,
    importError,
    setImportError,
    dirty,
    closeEditor,
    refreshLibrary,
    ensurePersistenceOnce,
    openScenario,
    showToast,
  } = deps;
  void creating;
  void error;
  void openId;
  void savedDocument;
  void revision;
  void saveError;
  void saving;
  void conflict;
  void importError;

  async function handleCreate(title: string) {
    setCreating(true);
    setError(null);
    try {
      await ensurePersistenceOnce();
      const created = createScenario({ title });
      const metadata = await getScenarioStore().save(created);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast('Scenario created.');
    } catch (createError) {
      if (isQuotaError(createError)) {
        setError(quotaFailureMessage('Create'));
      } else {
        setError(createError instanceof Error ? createError.message : String(createError));
      }
    } finally {
      setCreating(false);
    }
  }

  // Fold an older ruleset reference into the installed one as part of an
  // explicit Save. Opening never rebinds, so a scenario that only sits in
  // the editor keeps its stored reference; the rebound version is what Save
  // validates and stores.
  function withRulesetRebind(candidate: ScenarioDocument): ScenarioDocument {
    try {
      if (classifyRulesetReference(candidate?.ruleset).status === 'older') {
        return rebindRulesetToCurrent(candidate);
      }
    } catch {
      // Validation below reports malformed references.
    }
    return candidate;
  }

  async function handleSave(options: { overwrite?: boolean } = {}) {
    if (!document) return;
    const overwrite = options.overwrite === true;
    // An explicit Save rebinds an older ruleset reference to the installed
    // catalogue. Opening never rebinds: only this path changes the
    // reference, and the rebound document is what is validated and stored.
    // Unknown troop-type keys are preserved verbatim either way.
    // Structural errors block saving; warnings and the ruleset notice never
    // do: a scenario with warnings still saves.
    const candidate = withRulesetRebind(document);
    if (JSON.stringify(candidate?.ruleset) !== JSON.stringify(document?.ruleset)) {
      setDocument(candidate);
    }
    const problems = validateScenario(candidate);
    if (problems.length) {
      setSaveError('Cannot save: fix the highlighted problems.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await ensurePersistenceOnce();
      const storedEntry = ((await getScenarioStore().list()) as LibraryEntry[]).find(
        (item) => item.id === candidate.id,
      );
      const storedRevision =
        storedEntry && Number.isInteger(storedEntry.revision)
          ? (storedEntry.revision as number)
          : null;
      const metadata = await performSave(getScenarioStore(), candidate, {
        loadedRevision: revision,
        storedRevision,
        overwrite,
      });
      const reloaded = await getScenarioStore().load(metadata.id);
      setDocument(reloaded ?? candidate);
      setSavedDocument(cloneScenario(reloaded ?? candidate));
      setRevision(metadata.revision);
      setConflict(null);
      setSaveError(null);
      await refreshLibrary();
      showToast('Scenario saved.');
    } catch (saveFailure) {
      if (saveFailure instanceof SaveConflictError) {
        // Nothing has been stored: the author chooses between overwriting
        // and saving as a copy.
        setConflict({
          loadedRevision: saveFailure.loadedRevision,
          storedRevision: saveFailure.storedRevision,
        });
        return;
      }
      // The store save is atomic: a failure (for example a quota error)
      // leaves the previous version intact, so the author keeps working on
      // the same unsaved changes instead of losing them.
      if (isQuotaError(saveFailure)) {
        setSaveError(quotaFailureMessage('Save'));
      } else {
        setSaveError(saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
      }
    } finally {
      setSaving(false);
    }
  }

  function handleChange(next: ScenarioDocument) {
    if (!document || documentsMatch(next, document)) return;
    setHistory(historyCommit(history, cloneScenario(document)));
    setDocument(next);
  }

  function handleUndo() {
    if (!document) return;
    const stepped = historyUndo(history, cloneScenario(document));
    if (!stepped) return;
    setHistory(stepped.history);
    setDocument(stepped.document);
  }

  function handleRedo() {
    if (!document) return;
    const stepped = historyRedo(history, cloneScenario(document));
    if (!stepped) return;
    setHistory(stepped.history);
    setDocument(stepped.document);
  }

  async function handleSaveConflictCopy() {
    if (!document) return;
    setConflict(null);
    setSaving(true);
    setSaveError(null);
    try {
      await ensurePersistenceOnce();
      const copy = duplicateScenario(withRulesetRebind(document));
      const metadata = await getScenarioStore().save(copy);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast(`Saved as a new copy: ${copy.title}.`);
    } catch (copyFailure) {
      if (isQuotaError(copyFailure)) {
        setSaveError(quotaFailureMessage('Save as copy'));
      } else {
        setSaveError(copyFailure instanceof Error ? copyFailure.message : String(copyFailure));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate(id: string) {
    setError(null);
    try {
      const source = await getScenarioStore().load(id);
      if (!source) {
        setError('That scenario is no longer in the library.');
        await refreshLibrary();
        return;
      }
      if (isUnsupportedDocument(source)) {
        setError(
          `Cannot duplicate: this scenario needs a newer application (format version ${source.formatVersion}).`,
        );
        return;
      }
      // Duplicating never opens the scenario, but a copy of a reference
      // that cannot open is another entry that cannot open: refuse it like
      // opening.
      const reference = classifyRulesetReference(source.ruleset);
      if (reference.status === 'unknown-ruleset' || reference.status === 'newer') {
        setError(
          reference.status === 'unknown-ruleset'
            ? `Cannot duplicate: this scenario references an ${reference.cause}; the stored data was left untouched.`
            : `Cannot duplicate: this scenario ${reference.cause}.`,
        );
        return;
      }
      await ensurePersistenceOnce();
      const copy = duplicateScenario(source);
      await getScenarioStore().save(copy);
      await refreshLibrary();
      showToast(`Duplicated as "${copy.title}".`);
    } catch (duplicateError) {
      if (isQuotaError(duplicateError)) {
        setError(quotaFailureMessage('Duplicate'));
      } else {
        setError(duplicateError instanceof Error ? duplicateError.message : String(duplicateError));
      }
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this scenario?')) return;
    try {
      await getScenarioStore().remove(id);
      if (openId === id) {
        setOpenId(null);
        setDocument(null);
        setSavedDocument(null);
        setRevision(null);
        setSaveError(null);
        setConflict(null);
        const url = new URL(window.location.href);
        url.searchParams.delete('scenario');
        window.history.replaceState(null, '', url);
      }
      await refreshLibrary();
      showToast('Scenario deleted.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function handleExport(id: string | null) {
    try {
      const source = id ? await getScenarioStore().load(id) : document;
      if (!source) {
        showToast('Nothing to export.');
        return;
      }
      const { fileName, json } = exportScenario(source);
      downloadFile(fileName, json);
      showToast(`Exported ${fileName}.`);
    } catch (exportError) {
      showToast(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function handleExportRaw(id: string) {
    try {
      const record = await getScenarioStore().loadRaw(id);
      if (!record) {
        showToast('Nothing to export.');
        return;
      }
      const { fileName, json } = exportRawRecord(record);
      downloadFile(fileName, json);
      showToast(`Exported raw ${fileName}.`);
    } catch (exportError) {
      showToast(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function handleImportFile(file: File) {
    setImportError(null);
    try {
      const text = await file.text();
      // Parsing (and its specific rejection messages) runs before anything
      // is stored, so a rejected file leaves the library unchanged.
      const copy = importScenarioDocument(text);
      await ensurePersistenceOnce();
      const metadata = await getScenarioStore().save(copy);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast(`Imported as a new copy: ${copy.title}.`);
    } catch (importFailure) {
      if (isQuotaError(importFailure)) {
        setImportError(quotaFailureMessage('Import'));
      } else {
        setImportError(
          importFailure instanceof Error ? importFailure.message : String(importFailure),
        );
      }
    }
  }

  function handleBack() {
    if (dirty && !window.confirm('You have unsaved changes. Leave the editor without saving?')) {
      return;
    }
    closeEditor();
    const url = new URL(window.location.href);
    url.searchParams.delete('scenario');
    window.history.replaceState(null, '', url);
    void refreshLibrary();
  }

  return {
    handleCreate,
    withRulesetRebind,
    handleSave,
    handleChange,
    handleUndo,
    handleRedo,
    handleSaveConflictCopy,
    handleDuplicate,
    handleDelete,
    handleExport,
    handleExportRaw,
    handleImportFile,
    handleBack,
  };
}
