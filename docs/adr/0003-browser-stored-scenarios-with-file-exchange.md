# Scenarios are stored in the browser and exchanged as files

The first editor keeps its scenario library in the browser (IndexedDB), with no server storage, accounts, or synchronisation; exporting a scenario to a JSON file and importing it back is the only way to move, share, or back up a scenario. We chose this because the editor is used by one person on one desktop browser, and server storage would force hosting and account decisions nobody has asked for. Each stored or exported document carries a document kind, an integer format version, and a reference to the ruleset it is written for (identifier and version); older formats are migrated forward on load and nothing is ever migrated backwards. The library sits behind a narrow scenario store interface in the domain model, so server storage can replace it later without changing the editor.

## Considered Options

- **Server storage behind the Next.js application**: cross-device access, but it requires hosting, a database, and most likely accounts before the editor delivers anything.
- **Files on disk through the File System Access API**: only available in Chromium browsers, while the editor supports Firefox and Safari too, and it gives no library to browse.

## Consequences

- Browser data can be cleared or evicted. The application requests persistent storage and tells the author when it is refused; there is no version history, and an export is the only backup.
- Format version 1 is frozen with the first editor release; every later format change ships a forward migration. Development builds before that release carry no compatibility guarantee.
- Moving to server storage later means importing the authors' existing browser libraries, for example through the export format.
