// Background service worker for bookmark tab group management

// Create context menu items
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'edit-bookmark-tabgroup',
    title: 'Edit Tab Group Assignment',
    contexts: ['bookmark']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'edit-bookmark-tabgroup' && info.bookmarkId) {
    // Open popup with the selected bookmark
    chrome.action.openPopup();
    // Store the bookmark ID to pre-select it in popup
    chrome.storage.local.set({ contextMenuBookmarkId: info.bookmarkId });
  }
});

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

// Listen for tab updates to intercept bookmark opens
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only process when URL is loaded and it's not a chrome:// or extension page
  if (changeInfo.status === 'complete' && tab.url && 
      !tab.url.startsWith('chrome://') && 
      !tab.url.startsWith('chrome-extension://') &&
      !tab.url.startsWith('brave://')) {
    
    // Check if this URL matches any bookmark with a tab group assignment
    try {
      const result = await chrome.storage.local.get(['bookmarkTabGroups']);
      const bookmarkTabGroups = result.bookmarkTabGroups || {};
      
      // Find bookmark by URL
      const bookmarks = await chrome.bookmarks.search({ url: tab.url });
      if (bookmarks && bookmarks.length > 0) {
        const bookmark = bookmarks[0];
        const assignedTabGroupId = bookmarkTabGroups[bookmark.id];
        
        if (assignedTabGroupId) {
          // Check if tab is already in a group (groupId is -1 if not in a group)
          if (!tab.groupId || tab.groupId === -1) {
            // Move tab to assigned group
            try {
              // Verify group exists
              await chrome.tabGroups.get(assignedTabGroupId);
              await chrome.tabs.group({ tabIds: tabId, groupId: assignedTabGroupId });
            } catch (error) {
              // Group might not exist, create new one
              try {
                const newGroupId = await chrome.tabs.group({ tabIds: tabId });
                bookmarkTabGroups[bookmark.id] = newGroupId;
                await chrome.storage.local.set({ bookmarkTabGroups: bookmarkTabGroups });
              } catch (groupError) {
                // Tab might already be in a group, ignore
                console.debug('Could not create group:', groupError);
              }
            }
          }
        }
      }
    } catch (error) {
      // Silently fail - this is a best-effort feature
      console.debug('Could not assign tab group:', error);
    }
  }
});

// Function to open bookmark in its assigned tab group
async function openBookmarkInTabGroup(bookmarkId, url) {
  try {
    // Get the tab group assignment for this bookmark
    const result = await chrome.storage.local.get(['bookmarkTabGroups']);
    const bookmarkTabGroups = result.bookmarkTabGroups || {};
    const tabGroupId = bookmarkTabGroups[bookmarkId];

    if (tabGroupId) {
      // Create a new tab
      const tab = await chrome.tabs.create({ url: url, active: false });
      
      // Get the tab group details
      const group = await chrome.tabGroups.get(tabGroupId);
      
      if (group) {
        // Add the tab to the existing group
        await chrome.tabs.group({ tabIds: tab.id, groupId: tabGroupId });
      } else {
        // Group doesn't exist, create a new one
        const newGroupId = await chrome.tabs.group({ tabIds: tab.id });
        // Update storage with the new group ID
        bookmarkTabGroups[bookmarkId] = newGroupId;
        await chrome.storage.local.set({ bookmarkTabGroups: bookmarkTabGroups });
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
    
    for (const bookmark of bookmarks) {
      if (bookmark.url) {
        // It's a bookmark (not a folder)
        await openBookmarkInTabGroup(bookmark.id, bookmark.url);
      } else {
        // It's a folder, recursively open its children
        await openBookmarkFolderInTabGroups(bookmark.id);
      }
    }
  } catch (error) {
    console.error('Error opening bookmark folder:', error);
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
  
  if (request.action === 'saveBookmarkTabGroup') {
    chrome.storage.local.get(['bookmarkTabGroups'], (result) => {
      const bookmarkTabGroups = result.bookmarkTabGroups || {};
      if (request.tabGroupId) {
        bookmarkTabGroups[request.bookmarkId] = request.tabGroupId;
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
    chrome.storage.local.get(['bookmarkTabGroups'], (result) => {
      const bookmarkTabGroups = result.bookmarkTabGroups || {};
      sendResponse({ tabGroupId: bookmarkTabGroups[request.bookmarkId] || null });
    });
    return true;
  }
});

// Helper function to check and open bookmark in tab group (for future use)
function checkAndOpenInTabGroup(bookmark) {
  // This can be used for automatic opening when bookmarks are created
  // Currently, we rely on user interaction to open bookmarks
}
