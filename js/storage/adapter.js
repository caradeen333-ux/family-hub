// adapter.js — Storage adapter contract. Adapters are swap-in data backends:
//
//   DriveAdapter   (Google Drive REST, drive.file scope — first implementation)
//   WebDAVAdapter  (NAS/Nextcloud, later — same contract)
//
// Everything the sync engine needs from storage is behind this interface so a
// second backend is a new file, not a rewrite.

// Method names every adapter must implement
export const ADAPTER_METHODS = [
  'provision', // create family folder + dir.json + own first log → {folderId, dirFileId, logFileId}
  'join', // open dir.json by id (drive.file gesture), register own files → dirState
  'shareWith', // grant another user write access to the folder
  'readAllLogs', // fetch dir.json + all member logs → {dirState, logs[], malformed}
  'appendToMyLog', // RMW-append own events to own monthly file(s), read-back ack
  'createMonthlyFile', // ensure own monthly log exists for a month → fileId
  'registerFiles', // RMW-append own file ids into dir.json (convergent: append-only)
  'writeConfig', // config.upsert events appended to own log
  'readConfig', // merged config map from all logs
];

// Throw early with a clear message if an implementation is missing methods
export function assertAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) {
    throw new Error(`Storage adapter missing: ${missing.join(', ')}`);
  }
  return adapter;
}
