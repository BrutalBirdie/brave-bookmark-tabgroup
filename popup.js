// Popup script for bookmark tab group manager

let allBookmarks = [];
let allTabGroups = [];
let currentBookmarkId = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadBookmarks();
  loadTabGroups();
  
  // Check if opened from context menu
  chrome.storage.local.get(['contextMenuBookmarkId'], (result) => {
    if (result.contextMenuBookmarkId) {
      // Pre-select the bookmark from context menu
      setTimeout(() => {
        const select = document.getElementById('bookmarkSelect');
        select.value = result.contextMenuBookmarkId;
        handleBookmarkSelect({ target: select });
        // Clear the stored ID
        chrome.storage.local.remove(['contextMenuBookmarkId']);
      }, 500); // Wait for bookmarks to load
    }
  });
  
  // Event listeners
  document.getElementById('bookmarkSelect').addEventListener('change', handleBookmarkSelect);
  document.getElementById('tabGroupSelect').addEventListener('change', handleTabGroupSelect);
  document.getElementById('saveBtn').addEventListener('click', saveAssignment);
  document.getElementById('clearBtn').addEventListener('click', clearAssignment);
  document.getElementById('refreshBtn').addEventListener('click', loadBookmarks);
  document.getElementById('refreshGroupsBtn').addEventListener('click', loadTabGroups);
  document.getElementById('openBookmarkBtn').addEventListener('click', openSelectedBookmark);
  document.getElementById('openFolderBtn').addEventListener('click', openSelectedFolder);
});

// Load all bookmarks recursively
function loadBookmarks() {
  chrome.bookmarks.getTree((bookmarkTreeNodes) => {
    allBookmarks = [];
    flattenBookmarks(bookmarkTreeNodes, allBookmarks, '');
    
    const select = document.getElementById('bookmarkSelect');
    select.innerHTML = '<option value="">-- Select a bookmark or folder --</option>';
    
    allBookmarks.forEach(bookmark => {
      const option = document.createElement('option');
      option.value = bookmark.id;
      option.textContent = bookmark.prefix + bookmark.title + (bookmark.url ? '' : ' (folder)');
      select.appendChild(option);
    });
  });
}

// Flatten bookmark tree into a list
function flattenBookmarks(nodes, result, prefix) {
  nodes.forEach(node => {
    result.push({
      id: node.id,
      title: node.title,
      url: node.url,
      prefix: prefix
    });
    
    if (node.children) {
      flattenBookmarks(node.children, result, prefix + '  ');
    }
  });
}

// Load all tab groups
function loadTabGroups() {
  chrome.tabGroups.query({}, (groups) => {
    allTabGroups = groups;
    const select = document.getElementById('tabGroupSelect');
    const currentValue = select.value;
    const isCreatingNew = select.value === '__create_new__';
    
    select.innerHTML = '<option value="">-- No tab group (default) --</option>';
    select.appendChild(new Option('+ Create New Tab Group', '__create_new__'));
    
    groups.forEach(group => {
      const option = document.createElement('option');
      option.value = group.id;
      const colorName = getColorName(group.color);
      option.textContent = `${group.title || 'Untitled'} (${colorName})`;
      select.appendChild(option);
    });
    
    // Restore selection if it still exists
    if (isCreatingNew) {
      select.value = '__create_new__';
      handleTabGroupSelect({ target: select });
    } else if (currentValue && groups.find(g => g.id === parseInt(currentValue))) {
      select.value = currentValue;
    }
  });
}

// Get color name from color enum
function getColorName(color) {
  const colorMap = {
    'grey': 'Grey',
    'blue': 'Blue',
    'red': 'Red',
    'yellow': 'Yellow',
    'green': 'Green',
    'pink': 'Pink',
    'purple': 'Purple',
    'cyan': 'Cyan',
    'orange': 'Orange'
  };
  return colorMap[color] || color;
}

// Handle bookmark selection
function handleBookmarkSelect(event) {
  currentBookmarkId = event.target.value;
  const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
  
  if (currentBookmarkId) {
    document.getElementById('assignmentSection').style.display = 'block';
    document.getElementById('openBookmarkBtn').disabled = !bookmark || !bookmark.url;
    document.getElementById('openFolderBtn').disabled = !bookmark || bookmark.url !== undefined;
    
    // Load current assignment
    loadCurrentAssignment();
  } else {
    document.getElementById('assignmentSection').style.display = 'none';
    document.getElementById('openBookmarkBtn').disabled = true;
    document.getElementById('openFolderBtn').disabled = true;
  }
}

// Handle tab group selection
function handleTabGroupSelect(event) {
  const select = event.target;
  const createSection = document.getElementById('createGroupSection');
  
  if (select.value === '__create_new__') {
    createSection.style.display = 'block';
    document.getElementById('newGroupName').focus();
  } else {
    createSection.style.display = 'none';
    document.getElementById('newGroupName').value = '';
    document.getElementById('newGroupColor').value = 'grey';
  }
}

// Load current tab group assignment for selected bookmark
function loadCurrentAssignment() {
  if (!currentBookmarkId) return;
  
  chrome.runtime.sendMessage({
    action: 'getBookmarkTabGroup',
    bookmarkId: currentBookmarkId
  }, (response) => {
    if (response) {
      const select = document.getElementById('tabGroupSelect');
      
      // Try to match by ID first
      if (response.tabGroupId) {
        select.value = response.tabGroupId;
      } else if (response.tabGroupInfo) {
        // Group doesn't exist yet, but we have the info
        // Try to find a matching group by title and color
        const matchingGroup = allTabGroups.find(g => 
          (g.title === response.tabGroupInfo.title || (!g.title && !response.tabGroupInfo.title)) &&
          g.color === response.tabGroupInfo.color
        );
        
        if (matchingGroup) {
          select.value = matchingGroup.id;
        } else {
          // Show a message that the group needs to be recreated
          console.log('Tab group not found:', response.tabGroupInfo);
        }
      }
    }
  });
}

// Save assignment
function saveAssignment() {
  if (!currentBookmarkId) {
    showStatus('Please select a bookmark or folder first', 'error');
    return;
  }
  
  const tabGroupId = document.getElementById('tabGroupSelect').value;
  
  // Check if creating a new tab group
  if (tabGroupId === '__create_new__') {
    const groupName = document.getElementById('newGroupName').value.trim();
    const groupColor = document.getElementById('newGroupColor').value;
    
    if (!groupName) {
      showStatus('Please enter a tab group name', 'error');
      document.getElementById('newGroupName').focus();
      return;
    }
    
    // Create the new tab group
    chrome.runtime.sendMessage({
      action: 'createTabGroup',
      title: groupName,
      color: groupColor
    }, (response) => {
      if (response && response.success && response.tabGroupId) {
        // Now save the assignment with the new group
        chrome.runtime.sendMessage({
          action: 'saveBookmarkTabGroup',
          bookmarkId: currentBookmarkId,
          tabGroupId: response.tabGroupId,
          tabGroupTitle: groupName,
          tabGroupColor: groupColor
        }, (saveResponse) => {
          if (saveResponse && saveResponse.success) {
            const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
            showStatus(`Saved! "${bookmark.title}" will open in "${groupName}"`, 'success');
            // Reload tab groups and select the new one
            setTimeout(() => {
              loadTabGroups();
              setTimeout(() => {
                document.getElementById('tabGroupSelect').value = response.tabGroupId;
                document.getElementById('createGroupSection').style.display = 'none';
              }, 100);
            }, 200);
          } else {
            showStatus('Error saving assignment', 'error');
          }
        });
      } else {
        showStatus('Error creating tab group: ' + (response?.error || 'Unknown error'), 'error');
      }
    });
    return;
  }
  
  // Existing tab group selected
  const tabGroupIdInt = tabGroupId ? parseInt(tabGroupId) : null;
  
  // Get tab group details to store title and color
  const selectedGroup = tabGroupIdInt ? allTabGroups.find(g => g.id === tabGroupIdInt) : null;
  
  chrome.runtime.sendMessage({
    action: 'saveBookmarkTabGroup',
    bookmarkId: currentBookmarkId,
    tabGroupId: tabGroupIdInt,
    tabGroupTitle: selectedGroup ? selectedGroup.title : null,
    tabGroupColor: selectedGroup ? selectedGroup.color : null
  }, (response) => {
    if (response && response.success) {
      const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
      const groupName = selectedGroup 
        ? (selectedGroup.title || 'Untitled') + ' (' + getColorName(selectedGroup.color) + ')'
        : 'default';
      showStatus(`Saved! "${bookmark.title}" will open in ${groupName}`, 'success');
    } else {
      showStatus('Error saving assignment', 'error');
    }
  });
}

// Clear assignment
function clearAssignment() {
  if (!currentBookmarkId) {
    showStatus('Please select a bookmark or folder first', 'error');
    return;
  }
  
  document.getElementById('tabGroupSelect').value = '';
  
  chrome.runtime.sendMessage({
    action: 'saveBookmarkTabGroup',
    bookmarkId: currentBookmarkId,
    tabGroupId: null
  }, (response) => {
    if (response && response.success) {
      const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
      showStatus(`Cleared! "${bookmark.title}" will open normally`, 'success');
    } else {
      showStatus('Error clearing assignment', 'error');
    }
  });
}

// Open selected bookmark
function openSelectedBookmark() {
  if (!currentBookmarkId) return;
  
  const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
  if (!bookmark || !bookmark.url) return;
  
  chrome.runtime.sendMessage({
    action: 'openBookmarkInTabGroup',
    bookmarkId: currentBookmarkId,
    url: bookmark.url
  }, (response) => {
    if (response && response.success) {
      showStatus('Bookmark opened!', 'success');
    } else {
      showStatus('Error opening bookmark', 'error');
    }
  });
}

// Open selected folder
function openSelectedFolder() {
  if (!currentBookmarkId) return;
  
  const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
  if (bookmark && bookmark.url) return; // Not a folder
  
  chrome.runtime.sendMessage({
    action: 'openFolderInTabGroups',
    folderId: currentBookmarkId
  }, (response) => {
    if (response && response.success) {
      showStatus('Folder opened!', 'success');
    } else {
      showStatus('Error opening folder', 'error');
    }
  });
}

// Show status message
function showStatus(message, type) {
  const statusEl = document.getElementById('statusMessage');
  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  
  setTimeout(() => {
    statusEl.className = 'status-message';
    statusEl.textContent = '';
  }, 3000);
}
