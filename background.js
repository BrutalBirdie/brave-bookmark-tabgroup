// Background service worker for bookmark tab group management

// Set to true to debug bookmark-bar / redirect issues. See README Troubleshooting.
const DEBUG = false;
function dbg(...args) {
  if (DEBUG) console.log('[BTG]', ...args);
}

// Note: "bookmark" context menu was removed in MV3 — use the extension popup to assign tab groups.

// Listen for bookmark creation/update to check if it should open in a tab group
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  // Check if this bookmark has a tab group assignment
  checkAndOpenInTabGroup(bookmark);
});

// Listen for bookmark updates
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  // If bookmark was updated, check if it needs to open in a tab group
  chrome.bookmarks.get(id, (bookmarks) => {
    if (bookmarks && bookmarks[0]) {
      checkAndOpenInTabGroup(bookmarks[0]);
    }
  });
});

// Intercept bookmark clicks to open in assigned tab group
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  // Clean up storage if bookmark was deleted
  chrome.storage.local.get(['bookmarkTabGroups'], (result) => {
    if (result.bookmarkTabGroups) {
      delete result.bookmarkTabGroups[id];
      chrome.storage.local.set({ bookmarkTabGroups: result.bookmarkTabGroups });
    }
  });
});

// Track processed tabs to avoid duplicate processing
const processedTabs = new Set();

// Track first requested URL per tab. Used for bookmark lookup so we match the
// bookmark URL even after redirects (e.g. git.cloudron.io -> git.cloudron.io/explore).
const initialTabUrls = new Map();

function isInternalUrl(url) {
  return !url ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('brave://') ||
    url === 'about:blank';
}

// Store initial URL only the first time we see a valid one for this tab. Returns true if stored.
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

// Short-lived cache (title|color -> { groupId, ts }) so we reuse a group when opening
// a folder from the bookmark bar (multiple assignTabToBookmarkGroup calls in quick succession).
const GROUP_CACHE_TTL_MS = 3000;
const groupCache = new Map();

function cacheGroupId(title, color, groupId) {
  const key = `${title || ''}|${color || 'grey'}`;
  groupCache.set(key, { groupId, ts: Date.now() });
}

function getCachedGroupId(title, color) {
  const key = `${title || ''}|${color || 'grey'}`;
  const ent = groupCache.get(key);
  if (!ent || Date.now() - ent.ts > GROUP_CACHE_TTL_MS) {
    if (ent) groupCache.delete(key);
    return null;
  }
  return ent.groupId;
}

// Function to assign tab to group based on bookmark. Uses initial (pre-redirect) URL
// when available so we match the bookmark even if the tab redirects (e.g. 302).
async function assignTabToBookmarkGroup(tabId) {
  dbg('assignTabToBookmarkGroup: start', { tabId });

  if (processedTabs.has(tabId)) {
    dbg('assignTabToBookmarkGroup: skip already processed', { tabId });
    return;
  }

  let urlForLookup = initialTabUrls.get(tabId);
  if (!urlForLookup) {
    try {
      const tab = await chrome.tabs.get(tabId);
      dbg('assignTabToBookmarkGroup: no initial URL, fetched tab', { tabId, tabUrl: tab.url });
      if (isInternalUrl(tab.url)) {
        dbg('assignTabToBookmarkGroup: tab url internal, skip');
        return;
      }
      urlForLookup = tab.url;
      initialTabUrls.set(tabId, tab.url);
    } catch (e) {
      dbg('assignTabToBookmarkGroup: tabs.get failed', { tabId, err: e.message });
      return;
    }
  }
  dbg('assignTabToBookmarkGroup: lookup URL', { tabId, urlForLookup });

  try {
    const result = await chrome.storage.local.get(['bookmarkTabGroups']);
    const bookmarkTabGroups = result.bookmarkTabGroups || {};

    let bookmarks = await chrome.bookmarks.search({ url: urlForLookup });
    dbg('assignTabToBookmarkGroup: bookmark search', { url: urlForLookup, count: bookmarks?.length ?? 0, ids: bookmarks?.map(b => b.id) });

    // Fallback: redirects (e.g. 302) can mean we only ever see the final URL
    // (e.g. /explore). If no exact match, try origin (e.g. https://git.cloudron.io).
    if ((!bookmarks || bookmarks.length === 0) && urlForLookup) {
      let origin;
      try {
        origin = new URL(urlForLookup).origin;
      } catch (e) {
        origin = null;
      }
      if (origin && origin !== urlForLookup) {
        bookmarks = await chrome.bookmarks.search({ url: origin });
        dbg('assignTabToBookmarkGroup: bookmark search fallback (origin)', { origin, count: bookmarks?.length ?? 0, ids: bookmarks?.map(b => b.id) });
      }
    }

    if (!bookmarks || bookmarks.length === 0) {
      initialTabUrls.delete(tabId);
      dbg('assignTabToBookmarkGroup: no bookmarks found, done');
      return;
    }

    // Check all matching bookmarks (in case of duplicates)
    for (const bookmark of bookmarks) {
      // Check if this bookmark has an assignment
      let tabGroupInfo = bookmarkTabGroups[bookmark.id];
      
      // If bookmark doesn't have assignment, check parent folders
      if (!tabGroupInfo) {
        tabGroupInfo = await findFolderAssignment(bookmark.parentId, bookmarkTabGroups);
      }
      
      if (tabGroupInfo) {
        dbg('assignTabToBookmarkGroup: assignment found', { bookmarkId: bookmark.id, tabGroupInfo });
        const tab = await chrome.tabs.get(tabId);

        if (!tab.groupId || tab.groupId === -1) {
          let targetGroupId = null;

          if (typeof tabGroupInfo === 'object' && tabGroupInfo.title !== undefined) {
            const groupResult = await findOrCreateTabGroup(tabGroupInfo.title, tabGroupInfo.color);
            dbg('assignTabToBookmarkGroup: findOrCreateTabGroup', { title: tabGroupInfo.title, color: tabGroupInfo.color, result: groupResult });

            if (groupResult && typeof groupResult === 'object' && groupResult.create) {
              targetGroupId = await chrome.tabs.group({ tabIds: tabId });
              if (groupResult.title) {
                await chrome.tabGroups.update(targetGroupId, {
                  title: groupResult.title,
                  color: groupResult.color
                });
              }
              cacheGroupId(tabGroupInfo.title, tabGroupInfo.color, targetGroupId);
              dbg('assignTabToBookmarkGroup: created group', { targetGroupId });
            } else if (groupResult) {
              targetGroupId = groupResult;
              await chrome.tabs.group({ tabIds: tabId, groupId: targetGroupId });
              dbg('assignTabToBookmarkGroup: added to existing group', { targetGroupId });
            }
          } else if (typeof tabGroupInfo === 'number') {
            // Old format: try to use stored ID
            try {
              await chrome.tabGroups.get(tabGroupInfo);
              targetGroupId = tabGroupInfo;
              await chrome.tabs.group({ tabIds: tabId, groupId: targetGroupId });
            } catch (error) {
              // Group doesn't exist, ignore
              console.debug('Stored tab group ID no longer exists:', error);
            }
          }
          
          if (targetGroupId !== null) {
            processedTabs.add(tabId);
            dbg('assignTabToBookmarkGroup: success', { tabId, targetGroupId });
            setTimeout(() => {
              processedTabs.delete(tabId);
              initialTabUrls.delete(tabId);
            }, 5000);
            return;
          }
        } else {
          dbg('assignTabToBookmarkGroup: tab already in group', { tabId, groupId: tab.groupId });
          processedTabs.add(tabId);
          setTimeout(() => {
            processedTabs.delete(tabId);
            initialTabUrls.delete(tabId);
          }, 5000);
          return;
        }
      } else {
        dbg('assignTabToBookmarkGroup: bookmark has no assignment', { bookmarkId: bookmark.id });
      }
    }
    initialTabUrls.delete(tabId);
    dbg('assignTabToBookmarkGroup: no assignment for any bookmark, done');
  } catch (error) {
    dbg('assignTabToBookmarkGroup: error', { tabId, err: error.message, stack: error.stack });
    initialTabUrls.delete(tabId);
  }
}

// Helper function to find folder assignment by traversing up the bookmark tree
async function findFolderAssignment(folderId, bookmarkTabGroups) {
  if (!folderId) return null;
  
  // Check if this folder has an assignment
  if (bookmarkTabGroups[folderId]) {
    return bookmarkTabGroups[folderId];
  }
  
  // Get parent folder and check recursively
  try {
    const folder = await chrome.bookmarks.get(folderId);
    if (folder && folder[0] && folder[0].parentId) {
      return await findFolderAssignment(folder[0].parentId, bookmarkTabGroups);
    }
  } catch (error) {
    // Folder doesn't exist or is root
  }
  
  return null;
}

// Delay (ms) before running assign. Keep short so we run before fast redirects (e.g. ~78ms).
const ASSIGN_DELAY_MS = 25;

// Listen for tab creation to catch bookmarks opened from bookmark bar
chrome.tabs.onCreated.addListener((tab) => {
  dbg('onCreated', { tabId: tab.id, tabUrl: tab.url });
  if (tab.url && captureInitialUrl(tab.id, tab.url)) {
    dbg('onCreated: captured, schedule assign', { tabId: tab.id, delay: ASSIGN_DELAY_MS });
    setTimeout(() => assignTabToBookmarkGroup(tab.id), ASSIGN_DELAY_MS);
    return;
  }
  dbg('onCreated: no url or already had, schedule assign 80ms', { tabId: tab.id });
  setTimeout(() => assignTabToBookmarkGroup(tab.id), 80);
});

// Listen for tab updates: capture first requested URL (before redirect) and assign
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url || isInternalUrl(url)) return;
  if (!captureInitialUrl(tabId, url)) return;
  dbg('onUpdated: captured, schedule assign', { tabId, url, status: changeInfo.status, delay: ASSIGN_DELAY_MS });
  setTimeout(() => assignTabToBookmarkGroup(tabId), ASSIGN_DELAY_MS);
});

// Helper function to find or create a tab group by title and color
async function findOrCreateTabGroup(title, color) {
  try {
    const cached = getCachedGroupId(title, color);
    if (cached != null) {
      try {
        await chrome.tabGroups.get(cached);
        return cached;
      } catch (e) {
        groupCache.delete(`${title || ''}|${color || 'grey'}`);
      }
    }
    
    const allGroups = await chrome.tabGroups.query({});
    const matchingGroup = allGroups.find(g =>
      (g.title === title || (!g.title && !title)) &&
      g.color === color
    );
    
    if (matchingGroup) {
      return matchingGroup.id;
    }
    
    return { create: true, title: title, color: color };
  } catch (error) {
    console.error('Error finding tab group:', error);
    return null;
  }
}

// Function to open bookmark in its assigned tab group
async function openBookmarkInTabGroup(bookmarkId, url) {
  try {
    // Get the tab group assignment for this bookmark
    const result = await chrome.storage.local.get(['bookmarkTabGroups']);
    const bookmarkTabGroups = result.bookmarkTabGroups || {};
    const tabGroupInfo = bookmarkTabGroups[bookmarkId];

    if (tabGroupInfo) {
      // Create a new tab first
      const tab = await chrome.tabs.create({ url: url, active: false });
      
      // tabGroupInfo can be either:
      // - An object with {title, color} (new format)
      // - A number (old format - tab group ID, for backward compatibility)
      
      let targetGroupId = null;
      
      if (typeof tabGroupInfo === 'object' && tabGroupInfo.title !== undefined) {
        // New format: find or create group by title and color
        const groupResult = await findOrCreateTabGroup(tabGroupInfo.title, tabGroupInfo.color);
        
        if (groupResult && typeof groupResult === 'object' && groupResult.create) {
          // Need to create a new group
          targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
          // Set the title and color
          if (groupResult.title) {
            await chrome.tabGroups.update(targetGroupId, { 
              title: groupResult.title,
              color: groupResult.color 
            });
          }
        } else if (groupResult) {
          // Found existing group
          targetGroupId = groupResult;
          await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroupId });
        } else {
          // Fallback: create group without assignment
          targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
        }
      } else if (typeof tabGroupInfo === 'number') {
        // Old format: try to use the stored ID
        try {
          const group = await chrome.tabGroups.get(tabGroupInfo);
          if (group) {
            targetGroupId = tabGroupInfo;
            await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroupId });
          } else {
            // Group doesn't exist, create new one
            targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
          }
        } catch (error) {
          // Group ID invalid, create new one
          targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
        }
      }
    } else {
      // No tab group assigned, open normally
      await chrome.tabs.create({ url: url });
    }
  } catch (error) {
    console.error('Error opening bookmark in tab group:', error);
    // Fallback to normal tab creation
    chrome.tabs.create({ url: url });
  }
}

// Function to open all bookmarks in a folder in their assigned tab groups
async function openBookmarkFolderInTabGroups(folderId) {
  try {
    const bookmarks = await chrome.bookmarks.getChildren(folderId);
    const result = await chrome.storage.local.get(['bookmarkTabGroups']);
    const bookmarkTabGroups = result.bookmarkTabGroups || {};
    
    const folderTabGroupInfo = bookmarkTabGroups[folderId];
    // Reuse this groupId for subsequent bookmarks in the same folder to avoid
    // findOrCreateTabGroup races (second lookup sometimes missing the new group).
    let folderGroupId = null;
    
    for (const bookmark of bookmarks) {
      if (bookmark.url) {
        const bookmarkInfo = bookmarkTabGroups[bookmark.id];
        const info = bookmarkInfo || folderTabGroupInfo;
        
        if (info) {
          const useFolderGroup = !bookmarkInfo && folderTabGroupInfo;
          const reusedId = useFolderGroup ? folderGroupId : null;
          const usedGroupId = await openBookmarkInTabGroupWithInfo(
            bookmark.url,
            info,
            reusedId
          );
          if (useFolderGroup && usedGroupId) {
            folderGroupId = usedGroupId;
          }
        } else {
          await chrome.tabs.create({ url: bookmark.url });
          folderGroupId = null;
        }
      } else {
        const childFolderTabGroupInfo = bookmarkTabGroups[bookmark.id] || folderTabGroupInfo;
        if (childFolderTabGroupInfo) {
          bookmarkTabGroups[bookmark.id] = childFolderTabGroupInfo;
        }
        await openBookmarkFolderInTabGroups(bookmark.id);
      }
    }
  } catch (error) {
    console.error('Error opening bookmark folder:', error);
  }
}

// Helper function to open a bookmark with specific tab group info.
// Returns the groupId used (or null). Pass existingGroupId when opening a folder
// to reuse the same group for multiple bookmarks and avoid findOrCreate races.
async function openBookmarkInTabGroupWithInfo(url, tabGroupInfo, existingGroupId = null) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: url, active: false });
  } catch (e) {
    console.error('Error creating tab:', e);
    return null;
  }
  
  let targetGroupId = null;
  
  try {
    if (existingGroupId != null) {
      targetGroupId = existingGroupId;
      await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroupId });
      return targetGroupId;
    }
    
    if (typeof tabGroupInfo === 'object' && tabGroupInfo.title !== undefined) {
      const groupResult = await findOrCreateTabGroup(tabGroupInfo.title, tabGroupInfo.color);
      
      if (groupResult && typeof groupResult === 'object' && groupResult.create) {
        targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
        if (groupResult.title) {
          await chrome.tabGroups.update(targetGroupId, {
            title: groupResult.title,
            color: groupResult.color
          });
        }
        cacheGroupId(tabGroupInfo.title, tabGroupInfo.color, targetGroupId);
      } else if (groupResult) {
        targetGroupId = groupResult;
        await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroupId });
      } else {
        targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
      }
    } else if (typeof tabGroupInfo === 'number') {
      try {
        const group = await chrome.tabGroups.get(tabGroupInfo);
        if (group) {
          targetGroupId = tabGroupInfo;
          await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroupId });
        } else {
          targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
        }
      } catch (error) {
        targetGroupId = await chrome.tabs.group({ tabIds: tab.id });
      }
    }
    return targetGroupId;
  } catch (error) {
    console.error('Error opening bookmark in tab group:', error);
    // Tab already exists; do not create another. Leave it ungrouped.
    return null;
  }
}

// Listen for messages from popup/content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openBookmarkInTabGroup') {
    openBookmarkInTabGroup(request.bookmarkId, request.url)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'openFolderInTabGroups') {
    openBookmarkFolderInTabGroups(request.folderId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getTabGroups') {
    chrome.tabGroups.query({}, (groups) => {
      sendResponse({ groups: groups });
    });
    return true;
  }
  
  if (request.action === 'createTabGroup') {
    // Create a new tab group with the specified name and color
    // Tab groups require at least one tab, so we'll create a temporary placeholder tab
    (async () => {
      try {
        // Create a temporary placeholder tab (required for group creation)
        // This tab will stay open - user can close it manually if desired
        const tempTab = await chrome.tabs.create({ 
          url: 'about:blank',
          active: false 
        });
        
        // Create the group with the tab
        const groupId = await chrome.tabs.group({ tabIds: tempTab.id });
        
        // Update the group with title and color
        await chrome.tabGroups.update(groupId, {
          title: request.title || '',
          color: request.color || 'grey'
        });
        
        // Note: We keep the temporary tab open because empty tab groups are automatically removed
        // The user can close this tab manually if they want, or it will be used when opening bookmarks
        
        sendResponse({ success: true, tabGroupId: groupId });
      } catch (error) {
        console.error('Error creating tab group:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'saveBookmarkTabGroup') {
    chrome.storage.local.get(['bookmarkTabGroups'], async (result) => {
      const bookmarkTabGroups = result.bookmarkTabGroups || {};
      if (request.tabGroupId) {
        // Get the tab group details to store title and color (persistent identifiers)
        try {
          const group = await chrome.tabGroups.get(request.tabGroupId);
          if (group) {
            // Store by title and color instead of ID (persistent across sessions)
            bookmarkTabGroups[request.bookmarkId] = {
              title: group.title || '',
              color: group.color || 'grey'
            };
          } else {
            // Fallback: store the ID if we can't get group details
            bookmarkTabGroups[request.bookmarkId] = request.tabGroupId;
          }
        } catch (error) {
          // If group doesn't exist, try to get it from the request if provided
          if (request.tabGroupTitle !== undefined) {
            bookmarkTabGroups[request.bookmarkId] = {
              title: request.tabGroupTitle || '',
              color: request.tabGroupColor || 'grey'
            };
          } else {
            bookmarkTabGroups[request.bookmarkId] = request.tabGroupId;
          }
        }
      } else {
        delete bookmarkTabGroups[request.bookmarkId];
      }
      chrome.storage.local.set({ bookmarkTabGroups: bookmarkTabGroups }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
  
  if (request.action === 'getBookmarkTabGroup') {
    chrome.storage.local.get(['bookmarkTabGroups'], async (result) => {
      const bookmarkTabGroups = result.bookmarkTabGroups || {};
      const tabGroupInfo = bookmarkTabGroups[request.bookmarkId];
      
      if (!tabGroupInfo) {
        sendResponse({ tabGroupId: null, tabGroupInfo: null });
        return;
      }
      
      // If it's the new format (object with title/color), find matching group
      if (typeof tabGroupInfo === 'object' && tabGroupInfo.title !== undefined) {
        try {
          const allGroups = await chrome.tabGroups.query({});
          const matchingGroup = allGroups.find(g => 
            (g.title === tabGroupInfo.title || (!g.title && !tabGroupInfo.title)) && 
            g.color === tabGroupInfo.color
          );
          
          if (matchingGroup) {
            sendResponse({ 
              tabGroupId: matchingGroup.id,
              tabGroupInfo: tabGroupInfo 
            });
          } else {
            // Group doesn't exist yet, return the info so UI can show it
            sendResponse({ 
              tabGroupId: null,
              tabGroupInfo: tabGroupInfo 
            });
          }
        } catch (error) {
          sendResponse({ 
            tabGroupId: null,
            tabGroupInfo: tabGroupInfo 
          });
        }
      } else {
        // Old format: just return the ID
        sendResponse({ 
          tabGroupId: tabGroupInfo,
          tabGroupInfo: null 
        });
      }
    });
    return true;
  }
});

// Helper function to check and open bookmark in tab group (for future use)
function checkAndOpenInTabGroup(bookmark) {
  // This can be used for automatic opening when bookmarks are created
  // Currently, we rely on user interaction to open bookmarks
}
