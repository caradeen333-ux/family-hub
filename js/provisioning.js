// provisioning.js — Family setup wizard logic (no DOM — UI wires this in Phase 3).
//
// Flows:
//  - First person:  sign in → provision (folder + dir.json + own log) →
//                   member.joined + config.upsert events → invite others.
//  - Joining:       open invite link (#invite=<base64url JSON> {folderId,
//                   dirFileId}) → sign in with own account → adapter.join
//                   (the files.get is the drive.file "open" gesture) →
//                   member.joined event.
//
// Member keys are derived from email local-parts (sanitized); the family
// config may override keys later via config.upsert. Calendar sharing between
// members is a manual one-time runbook, not provisioning's job.

import { makeEvent } from './storage/log-format.js';

// Sanitize an email local-part into a member key: lowercase alphanumerics only
export function deriveMemberKey(email) {
  const local = String(email ?? '').split('@')[0] ?? '';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) throw new Error(`Cannot derive a member key from "${email}"`);
  return cleaned;
}

// Build the invite link a first member shares with the family.
// CRITICAL: the link must ALWAYS use the public web origin — never the
// app's own origin. (Electron runs on http://127.0.0.1:41073 and the
// first real invite embedded that dead local address.)
export function inviteOrigin() {
  if (typeof window !== 'undefined' && window.__electron) {
    return 'https://caradeen333-ux.github.io/family-hub';
  }
  return typeof window !== 'undefined' ? window.location.origin : 'https://caradeen333-ux.github.io/family-hub';
}

export function buildInviteLink({ folderId, dirFileId, origin = inviteOrigin() }) {
  const payload = JSON.stringify({ v: 1, folderId, dirFileId });
  const encoded = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${origin}/#invite=${encoded}`;
}

// Parse #invite= from the current hash (or any hash string)
export function parseInvite(hash = window.location?.hash ?? '') {
  const m = /^#invite=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
    const data = JSON.parse(json);
    if (data?.v === 1 && typeof data.folderId === 'string' && typeof data.dirFileId === 'string') {
      return { folderId: data.folderId, dirFileId: data.dirFileId };
    }
    return null;
  } catch {
    return null;
  }
}

// First person provisions the family. Returns {folderId, dirFileId, logFileId}
// familyName is the FAMILY's own name — the founder's name is just their
// member name, never the name on entry (owner feedback 2026-09-09).
export async function provisionFirstUser(adapter, { name, email, familyName, clock = () => Date.now() }) {
  const memberKey = deriveMemberKey(email);
  const { folderId, dirFileId } = await adapter.provision({ name, email });
  const month = new Date(clock());

  // Register self in dir.json, then append the founding events to the log
  const { logFileId } = await adapter.join({ folderId, dirFileId, memberKey, name, email });
  const events = [
    makeEvent('member.joined', memberKey, { key: memberKey, name, email }, { now: clock() }),
    makeEvent('config.upsert', memberKey, { key: 'appPrefs', value: { createdBy: memberKey } }, { now: clock() }),
    ...(familyName?.trim()
      ? [makeEvent('config.upsert', memberKey, { key: 'familyName', value: familyName.trim() }, { now: clock() })]
      : []),
  ];
  await adapter.appendToMyLog({ folderId, dirFileId, memberKey, name, email, events });

  return { folderId, dirFileId, logFileId, memberKey };
}

// A new member joins via the invite link. The adapter resolves the final
// member key (collisions get a numeric suffix) — always use the returned key.
export async function joinFamily(adapter, { invite, name, email, clock = () => Date.now() }) {
  const memberKey = deriveMemberKey(email);
  const { folderId, dirFileId, logFileId, memberKey: actualKey } = await adapter.join({
    folderId: invite.folderId,
    dirFileId: invite.dirFileId,
    memberKey,
    name,
    email,
  });

  const events = [
    makeEvent('member.joined', actualKey, { key: actualKey, name, email }, { now: clock() }),
  ];
  await adapter.appendToMyLog({ folderId, dirFileId, memberKey: actualKey, name, email, events });

  return { folderId, dirFileId, logFileId, memberKey: actualKey };
}
