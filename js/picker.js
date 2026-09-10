// picker.js — Google Drive Picker bridge for the join flow.
//
// Under drive.file scope, a file shared with the invitee stays invisible to
// the app until the user opens it through Google's own picker — the pick IS
// the "open gesture" Google records. This module opens that picker scoped to
// folders, so a joining member can find the family folder in "Shared with me"
// and explicitly hand the app per-file access to it.
//
// The picker runs on the project's appId (the client-ID prefix / project
// number) with the invitee's own access token. It is only used on the web
// sign-in path — Electron never needs it.

import { CONFIG } from './config.js';

let gapiPromise = null;

// Load the Google API loader once, on demand (keeps the Pages payload light)
function loadGapi() {
  if (!gapiPromise) {
    gapiPromise = new Promise((resolve, reject) => {
      if (window.gapi?.load) return resolve(window.gapi);
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => resolve(window.gapi);
      script.onerror = () => reject(new Error('Could not load Google APIs — check your connection'));
      document.head.appendChild(script);
    });
  }
  return gapiPromise;
}

function loadPicker(gapi) {
  return new Promise((resolve, reject) => {
    gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Picker failed to load')) });
  });
}

// Opens the Drive picker on a user gesture. Resolves the picked doc
// ({id, type, name}) or null when the user cancels. Throws when the picker
// is not configured yet (no API key) or fails to load.
export async function pickFamilyFolder({ token }) {
  if (!CONFIG.pickerApiKey) {
    throw new Error('Folder picker is not configured yet — ask the family to re-send the invite in a little while');
  }
  const gapi = await loadGapi();
  await loadPicker(gapi);

  return new Promise((resolve) => {
    // Docs (files) view, not the FOLDERS view: the folder view only shows
    // the user's own Drive, and the family folder lives in "Shared with me"
    // for a joiner. includeFolders + selectFolderEnabled lets them pick the
    // folder itself from that shared list — the pick authorizes the folder
    // AND its contents under drive.file.
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);
    const picker = new google.picker.PickerBuilder()
      .setAppId(CONFIG.pickerAppId)
      .setDeveloperKey(CONFIG.pickerApiKey)
      .setOAuthToken(token)
      .addView(view)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED && data.docs?.length) {
          const doc = data.docs[0];
          resolve({ id: doc.id, type: doc.type, name: doc.name });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
