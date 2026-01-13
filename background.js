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
        const tabGroupInfo = bookmarkTabGroups[bookmark.id];
        
        if (tabGroupInfo) {
          // Check if tab is already in a group (groupId is -1 if not in a group)
          if (!tab.groupId || tab.groupId === -1) {
            let targetGroupId = null;
            
            // Handle both old format (ID) and new format (title/color)
            if (typeof tabGroupInfo === 'object' && tabGroupInfo.title !== undefined) {
              // New format: find or create by title and color
              const groupResult = await findOrCreateTabGroup(tabGroupInfo.title, tabGroupInfo.color);
              
              if (groupResult && typeof groupResult === 'object' && groupResult.create) {
                // Need to create group
                targetGroupId = await chrome.tabs.group({ tabIds: tabId });
                if (groupResult.title) {
                  await chrome.tabGroups.update(targetGroupId, {
                    title: groupResult.title,
                    color: groupResult.color
                  });
                }
              } else if (groupResult) {
                targetGroupId = groupResult;
                await chrome.tabs.group({ tabIds: tabId, groupId: targetGroupId });
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
          }
        }
      }
    } catch (error) {
      // Silently fail - this is a best-effort feature
      console.debug('Could not assign tab group:', error);
    }
  }
});

// Helper function to find or create a tab group by title and color
async function findOrCreateTabGroup(title, color) {
  try {
    // First, try to find an existing group with matching title and color
    const allGroups = await chrome.tabGroups.query({});
    const matchingGroup = allGroups.find(g => 
      (g.title === title || (!g.title && !title)) && 
      g.color === color
    );
    
    if (matchingGroup) {
      return matchingGroup.id;
    }
    
    // Group doesn't exist, we'll need to create it when we have a tab
    // Return a marker object to indicate we need to create it
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
    
    // Check if the folder itself has a tab group assignment
    const folderTabGroupInfo = bookmarkTabGroups[folderId];
    
    for (const bookmark of bookmarks) {
      if (bookmark.url) {
        // It's a bookmark (not a folder)
        // Check if this specific bookmark has an assignment, otherwise use folder assignment
        const bookmarkTabGroupInfo = bookmarkTabGroups[bookmark.id] || folderTabGroupInfo;
        
        if (bookmarkTabGroupInfo) {
          // Open bookmark with the appropriate tab group info
          // We'll pass the tab group info directly instead of relying on storage
          await openBookmarkInTabGroupWithInfo(bookmark.url, bookmarkTabGroupInfo);
        } else {
          // No assignment, open normally
          await chrome.tabs.create({ url: bookmark.url });
        }
      } else {
        // It's a folder, recursively open its children
        // Pass down the folder's tab group info if it exists
        const childFolderTabGroupInfo = bookmarkTabGroups[bookmark.id] || folderTabGroupInfo;
        if (childFolderTabGroupInfo) {
          // Temporarily store it for the recursive call
          bookmarkTabGroups[bookmark.id] = childFolderTabGroupInfo;
        }
        await openBookmarkFolderInTabGroups(bookmark.id);
      }
    }
  } catch (error) {
    console.error('Error opening bookmark folder:', error);
  }
}

// Helper function to open a bookmark with specific tab group info
async function openBookmarkInTabGroupWithInfo(url, tabGroupInfo) {
  try {
    // Create a new tab first
    const tab = await chrome.tabs.create({ url: url, active: false });
    
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
  } catch (error) {
    console.error('Error opening bookmark in tab group:', error);
    // Fallback to normal tab creation
    chrome.tabs.create({ url: url });
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
