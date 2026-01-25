// Background service worker for bookmark tab group management
// Supports Chromium (MV3 service worker) and Firefox (background.scripts).

// ─── Config & debug ─────────────────────────────────────────────────────────
const DEBUG = false;
function dbg(...args) {
  if (DEBUG) console.log('[BTG]', ...args);
}

const ASSIGN_DELAY_MS = 25;   // Run before fast redirects (~78ms)
const GROUP_CACHE_TTL_MS = 3000;
const CLEANUP_DELAY_MS = 5000;

// ─── State ──────────────────────────────────────────────────────────────────
const processedTabs = new Set();
const initialTabUrls = new Map();
const groupCache = new Map();

// ─── URL helpers ────────────────────────────────────────────────────────────
function isInternalUrl(url) {
  if (!url || url === 'about:blank') return true;
  const internal = ['chrome://', 'chrome-extension://', 'brave://', 'moz-extension://'];
  return internal.some((p) => url.startsWith(p));
}

/** Store first non-internal URL per tab (for redirect-safe bookmark lookup). Returns true if stored. */
function captureInitialUrl(tabId, url) {
  if (isInternalUrl(url)) {
    dbg('captureInitialUrl: skip internal', { tabId, url });
    return false;
  }
  if (initialTabUrls.has(tabId)) {
    dbg('captureInitialUrl: already have', { tabId, had: initialTabUrls.get(tabId), now: url });
    return false;
  }
  initialTabUrls.set(tabId, url);
  dbg('captureInitialUrl: stored', { tabId, url });
  return true;
}

// ─── Group cache (title|color → groupId) ─────────────────────────────────────
function groupCacheKey(title, color) {
  return `${title ?? ''}|${color ?? 'grey'}`;
}

function getCachedGroupId(title, color) {
  const key = groupCacheKey(title, color);
  const ent = groupCache.get(key);
  if (!ent || Date.now() - ent.ts > GROUP_CACHE_TTL_MS) {
    if (ent) groupCache.delete(key);
    return null;
  }
  return ent.groupId;
}

function setCachedGroupId(title, color, groupId) {
  groupCache.set(groupCacheKey(title, color), { groupId, ts: Date.now() });
}

// ─── Tab group info format helpers ───────────────────────────────────────────
function isTitleColorFormat(info) {
  return info && typeof info === 'object' && info.title !== undefined;
}

function isLegacyIdFormat(info) {
  return typeof info === 'number';
}

// ─── Storage helpers ────────────────────────────────────────────────────────
async function getBookmarkTabGroups() {
  const r = await chrome.storage.local.get(['bookmarkTabGroups']);
  return r.bookmarkTabGroups ?? {};
}

async function saveBookmarkTabGroups(data) {
  await chrome.storage.local.set({ bookmarkTabGroups: data });
}

// ─── Folder assignment (walk up bookmark tree) ───────────────────────────────
async function findFolderAssignment(folderId, bookmarkTabGroups) {
  if (!folderId) return null;
  if (bookmarkTabGroups[folderId]) return bookmarkTabGroups[folderId];
  try {
    const [folder] = await chrome.bookmarks.get(folderId);
    if (folder?.parentId) return findFolderAssignment(folder.parentId, bookmarkTabGroups);
  } catch {
    /* folder missing or root */
  }
  return null;
}

// ─── Find or create tab group ───────────────────────────────────────────────
/** Returns groupId (number) or { create: true, title, color }. */
async function findOrCreateTabGroup(title, color) {
  try {
    const cached = getCachedGroupId(title, color);
    if (cached != null) {
      try {
        await chrome.tabGroups.get(cached);
        return cached;
      } catch {
        groupCache.delete(groupCacheKey(title, color));
      }
    }

    const all = await chrome.tabGroups.query({});
    const match = all.find(
      (g) => (g.title === title || (!g.title && !title)) && g.color === color
    );
    if (match) return match.id;

    return { create: true, title, color };
  } catch (e) {
    console.error('findOrCreateTabGroup:', e);
    return null;
  }
}

// ─── Apply group to tab (create vs add to existing) ──────────────────────────
/** Groups tab by groupResult (groupId or { create, title, color }). Returns groupId or null. */
async function applyGroupToTab(tabId, groupResult, tabGroupInfo) {
  if (!groupResult) return null;

  if (typeof groupResult === 'object' && groupResult.create) {
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    if (groupResult.title != null || groupResult.color != null) {
      await chrome.tabGroups.update(groupId, {
        title: groupResult.title ?? '',
        color: groupResult.color ?? 'grey',
      });
    }
    if (tabGroupInfo && isTitleColorFormat(tabGroupInfo)) {
      setCachedGroupId(tabGroupInfo.title, tabGroupInfo.color, groupId);
    }
    return groupId;
  }

  if (typeof groupResult === 'number') {
    await chrome.tabs.group({ tabIds: tabId, groupId: groupResult });
    return groupResult;
  }

  return null;
}

// ─── Resolve group from stored tabGroupInfo (title/color or legacy ID) ───────
/** Returns groupId, { create, title, color }, or null. */
async function resolveGroupFromInfo(tabGroupInfo) {
  if (!tabGroupInfo) return null;

  if (isTitleColorFormat(tabGroupInfo)) {
    return findOrCreateTabGroup(tabGroupInfo.title, tabGroupInfo.color);
  }

  if (isLegacyIdFormat(tabGroupInfo)) {
    try {
      await chrome.tabGroups.get(tabGroupInfo);
      return tabGroupInfo;
    } catch {
      return null;
    }
  }

  return null;
}

// ─── Tab cleanup (processedTabs + initialTabUrls) ────────────────────────────
function scheduleTabCleanup(tabId) {
  processedTabs.add(tabId);
  setTimeout(() => {
    processedTabs.delete(tabId);
    initialTabUrls.delete(tabId);
  }, CLEANUP_DELAY_MS);
}

function scheduleAssign(tabId, delay = ASSIGN_DELAY_MS) {
  setTimeout(() => assignTabToBookmarkGroup(tabId), delay);
}

// ─── Assign tab to group when opened from bookmark bar ───────────────────────
async function assignTabToBookmarkGroup(tabId) {
  dbg('assignTabToBookmarkGroup: start', { tabId });
  if (processedTabs.has(tabId)) {
    dbg('assignTabToBookmarkGroup: skip processed', { tabId });
    return;
  }

  let urlForLookup = initialTabUrls.get(tabId);
  if (!urlForLookup) {
    try {
      const tab = await chrome.tabs.get(tabId);
      dbg('assignTabToBookmarkGroup: no initial URL', { tabId, tabUrl: tab?.url });
      if (isInternalUrl(tab?.url)) return;
      urlForLookup = tab.url;
      initialTabUrls.set(tabId, tab.url);
    } catch (e) {
      dbg('assignTabToBookmarkGroup: tabs.get failed', { tabId, err: e?.message });
      return;
    }
  }
  dbg('assignTabToBookmarkGroup: lookup', { tabId, urlForLookup });

  try {
    const bookmarkTabGroups = await getBookmarkTabGroups();
    let bookmarks = await chrome.bookmarks.search({ url: urlForLookup });

    if (!bookmarks?.length && urlForLookup) {
      try {
        const origin = new URL(urlForLookup).origin;
        if (origin !== urlForLookup) {
          bookmarks = await chrome.bookmarks.search({ url: origin });
          dbg('assignTabToBookmarkGroup: fallback origin', { origin, count: bookmarks?.length });
        }
      } catch {
        /* invalid URL */
      }
    }

    if (!bookmarks?.length) {
      initialTabUrls.delete(tabId);
      dbg('assignTabToBookmarkGroup: no bookmarks');
      return;
    }

    for (const b of bookmarks) {
      let info = bookmarkTabGroups[b.id] ?? (await findFolderAssignment(b.parentId, bookmarkTabGroups));
      if (!info) {
        dbg('assignTabToBookmarkGroup: no assignment', { bookmarkId: b.id });
        continue;
      }

      dbg('assignTabToBookmarkGroup: assignment found', { bookmarkId: b.id, info });
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId != null && tab.groupId !== -1) {
        dbg('assignTabToBookmarkGroup: already in group', { tabId, groupId: tab.groupId });
        scheduleTabCleanup(tabId);
        return;
      }

      const groupResult = await resolveGroupFromInfo(info);
      const groupId = await applyGroupToTab(tabId, groupResult, info);

      if (groupId != null) {
        dbg('assignTabToBookmarkGroup: success', { tabId, groupId });
        scheduleTabCleanup(tabId);
        return;
      }
    }

    initialTabUrls.delete(tabId);
    dbg('assignTabToBookmarkGroup: no assignment for any');
  } catch (e) {
    dbg('assignTabToBookmarkGroup: error', { tabId, err: e?.message });
    initialTabUrls.delete(tabId);
  }
}

// ─── Tab listeners (bookmark bar opens) ──────────────────────────────────────
chrome.tabs.onCreated.addListener((tab) => {
  dbg('onCreated', { tabId: tab.id, tabUrl: tab.url });
  const captured = tab.url && captureInitialUrl(tab.id, tab.url);
  scheduleAssign(tab.id, captured ? ASSIGN_DELAY_MS : 80);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab?.url;
  if (!url || isInternalUrl(url)) return;
  if (!captureInitialUrl(tabId, url)) return;
  dbg('onUpdated: captured', { tabId, url });
  scheduleAssign(tabId);
});

// ─── Open bookmark in tab group ──────────────────────────────────────────────
/** Opens URL in a new tab and groups it. Returns groupId or null. Reuse existingGroupId when opening folders. */
async function openBookmarkInTabGroupWithInfo(url, tabGroupInfo, existingGroupId = null) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.error('openBookmarkInTabGroupWithInfo: create tab', e);
    return null;
  }

  try {
    if (existingGroupId != null) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroupId });
      return existingGroupId;
    }

    const groupResult = await resolveGroupFromInfo(tabGroupInfo);
    if (!groupResult) {
      await chrome.tabs.group({ tabIds: tab.id });
      return null;
    }
    return applyGroupToTab(tab.id, groupResult, tabGroupInfo);
  } catch (e) {
    console.error('openBookmarkInTabGroupWithInfo: group', e);
    return null;
  }
}

async function openBookmarkInTabGroup(bookmarkId, url) {
  try {
    const groups = await getBookmarkTabGroups();
    const info = groups[bookmarkId];
    if (!info) {
      await chrome.tabs.create({ url });
      return;
    }
    const tab = await chrome.tabs.create({ url, active: false });
    const groupResult = await resolveGroupFromInfo(info);
    const groupId = await applyGroupToTab(tab.id, groupResult, info);
    if (groupResult == null && groupId == null) {
      await chrome.tabs.group({ tabIds: tab.id });
    }
  } catch (e) {
    console.error('openBookmarkInTabGroup', e);
    chrome.tabs.create({ url });
  }
}

async function openBookmarkFolderInTabGroups(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    const groups = await getBookmarkTabGroups();
    const folderInfo = groups[folderId];
    let folderGroupId = null;

    for (const node of children) {
      if (node.url) {
        const info = groups[node.id] ?? folderInfo;
        if (info) {
          const useFolderGroup = !groups[node.id] && folderInfo;
          const reuseId = useFolderGroup ? folderGroupId : null;
          const usedId = await openBookmarkInTabGroupWithInfo(node.url, info, reuseId);
          if (useFolderGroup && usedId != null) folderGroupId = usedId;
        } else {
          await chrome.tabs.create({ url: node.url });
          folderGroupId = null;
        }
      } else {
        await openBookmarkFolderInTabGroups(node.id);
      }
    }
  } catch (e) {
    console.error('openBookmarkFolderInTabGroups', e);
  }
}

// ─── Bookmark listeners ──────────────────────────────────────────────────────
chrome.bookmarks.onRemoved.addListener(async (id) => {
  const groups = await getBookmarkTabGroups();
  if (id in groups) {
    delete groups[id];
    await saveBookmarkTabGroups(groups);
  }
});

// ─── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  const reply = (ok, data = {}) => sendResponse({ success: ok, ...data });
  const replyErr = (e) => sendResponse({ success: false, error: e?.message });

  if (req.action === 'openBookmarkInTabGroup') {
    openBookmarkInTabGroup(req.bookmarkId, req.url).then(() => reply(true)).catch(replyErr);
    return true;
  }

  if (req.action === 'openFolderInTabGroups') {
    openBookmarkFolderInTabGroups(req.folderId).then(() => reply(true)).catch(replyErr);
    return true;
  }

  if (req.action === 'getTabGroups') {
    chrome.tabGroups.query({}).then((groups) => reply(true, { groups })).catch(replyErr);
    return true;
  }

  if (req.action === 'saveBookmarkTabGroup') {
    (async () => {
      const groups = await getBookmarkTabGroups();
      if (req.tabGroupId != null) {
        try {
          const g = await chrome.tabGroups.get(req.tabGroupId);
          groups[req.bookmarkId] = { title: g.title ?? '', color: g.color ?? 'grey' };
        } catch {
          groups[req.bookmarkId] = req.tabGroupTitle != null
            ? { title: req.tabGroupTitle ?? '', color: req.tabGroupColor ?? 'grey' }
            : req.tabGroupId;
        }
      } else if (req.tabGroupTitle != null) {
        groups[req.bookmarkId] = { title: req.tabGroupTitle ?? '', color: req.tabGroupColor ?? 'grey' };
      } else {
        delete groups[req.bookmarkId];
      }
      await saveBookmarkTabGroups(groups);
      reply(true);
    })().catch(replyErr);
    return true;
  }

  if (req.action === 'getBookmarkTabGroup') {
    (async () => {
      const groups = await getBookmarkTabGroups();
      const info = groups[req.bookmarkId];
      if (!info) {
        sendResponse({ tabGroupId: null, tabGroupInfo: null });
        return;
      }
      if (isLegacyIdFormat(info)) {
        sendResponse({ tabGroupId: info, tabGroupInfo: null });
        return;
      }
      const all = await chrome.tabGroups.query({});
      const match = all.find(
        (g) => (g.title === info.title || (!g.title && !info.title)) && g.color === info.color
      );
      sendResponse({ tabGroupId: match?.id ?? null, tabGroupInfo: info });
    })().catch(() => sendResponse({ tabGroupId: null, tabGroupInfo: null }));
    return true;
  }

  return false;
});
