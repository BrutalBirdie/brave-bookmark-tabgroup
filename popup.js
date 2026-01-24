// Popup script for bookmark tab group manager

let allBookmarks = [];
let allTabGroups = [];
let currentBookmarkId = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadBookmarks();
  loadTabGroups();

  // Event listeners
  document.getElementById('bookmarkSelect').addEventListener('change', handleBookmarkSelect);
  document.getElementById('tabGroupSelect').addEventListener('change', (e) => {
    handleTabGroupSelect(e);
    updateSelectTitle(e.target);
  });
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
      return;
    }
    if (currentValue && currentValue.startsWith('__stored__|')) {
      // Stored config (group deleted) — restore via loadCurrentAssignment
      if (currentBookmarkId) loadCurrentAssignment();
      return;
    }
    if (currentValue && groups.find(g => g.id === parseInt(currentValue))) {
      select.value = currentValue;
      updateSelectTitle(select);
    }
    
    // Re-apply stored assignment when group was deleted (adds __stored__ option if needed)
    if (currentBookmarkId) loadCurrentAssignment();
  });
}

// Update select title (tooltip) with full option text so hover shows full value when truncated
function updateSelectTitle(select) {
  if (!select || select.id !== 'tabGroupSelect') return;
  const opt = select.selectedOptions?.[0];
  const full = opt?.dataset?.fullText ?? opt?.textContent ?? '';
  select.title = full;
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
    const greyRadio = document.getElementById('color-grey');
    if (greyRadio) greyRadio.checked = true;
  }
}

// Load current tab group assignment for selected bookmark
function loadCurrentAssignment() {
  if (!currentBookmarkId) return;
  
  chrome.runtime.sendMessage({
    action: 'getBookmarkTabGroup',
    bookmarkId: currentBookmarkId
  }, (response) => {
    const select = document.getElementById('tabGroupSelect');
    
    // Remove any existing "stored config" option (group deleted)
    for (let i = select.options.length - 1; i >= 0; i--) {
      if (select.options[i].value.startsWith('__stored__|')) {
        select.remove(i);
      }
    }
    
    if (!response) {
      select.value = '';
      updateSelectTitle(select);
      return;
    }
    
    // Match by existing tab group ID
    if (response.tabGroupId) {
      const exists = allTabGroups.some(g => g.id === response.tabGroupId);
      if (exists) {
        select.value = response.tabGroupId;
        updateSelectTitle(select);
        return;
      }
    }
    
    // We have stored config (title/color)
    if (response.tabGroupInfo) {
      const info = response.tabGroupInfo;
      const emptyConfig = (!info.title || info.title === '') && (!info.color || info.color === 'grey');
      if (emptyConfig) {
        select.value = '';
        updateSelectTitle(select);
        chrome.runtime.sendMessage({
          action: 'saveBookmarkTabGroup',
          bookmarkId: currentBookmarkId,
          tabGroupId: null
        });
        return;
      }
      const matchingGroup = allTabGroups.find(g =>
        (g.title === info.title || (!g.title && !info.title)) &&
        g.color === info.color
      );
      
      if (matchingGroup) {
        select.value = matchingGroup.id;
        updateSelectTitle(select);
        return;
      }
      
      // Group deleted: add option for saved config and select it
      const colorName = getColorName(info.color);
      const shortLabel = (info.title || 'Untitled') + ' (' + colorName + ') • saved';
      const fullLabel = (info.title || 'Untitled') + ' (' + colorName + ') — group closed, recreated when opening';
      const value = '__stored__|' + (info.title || '') + '|' + (info.color || 'grey');
      const opt = new Option(shortLabel, value);
      opt.dataset.fullText = fullLabel;
      select.appendChild(opt);
      select.value = value;
      updateSelectTitle(select);
      return;
    }
    
    select.value = '';
    updateSelectTitle(select);
  });
}

// Save assignment
function saveAssignment() {
  if (!currentBookmarkId) {
    showStatus('Please select a bookmark or folder first', 'error');
    return;
  }
  
  const tabGroupId = document.getElementById('tabGroupSelect').value;
  
  // Stored config (group deleted) — assignment already saved, nothing to do
  if (tabGroupId.startsWith('__stored__|')) {
    showStatus('Assignment unchanged. Bookmark will open in saved group when used.', 'success');
    return;
  }
  
  // Check if creating a new tab group
  if (tabGroupId === '__create_new__') {
    const groupName = document.getElementById('newGroupName').value.trim();
    const groupColor = document.querySelector('input[name="newGroupColor"]:checked')?.value || 'grey';
    
    if (!groupName) {
      showStatus('Please enter a tab group name', 'error');
      document.getElementById('newGroupName').focus();
      return;
    }
    
    // Store as virtual group (title+color only). No tab/group created; group
    // is created when the bookmark is opened, same as when a saved group was deleted.
    chrome.runtime.sendMessage({
      action: 'saveBookmarkTabGroup',
      bookmarkId: currentBookmarkId,
      tabGroupId: null,
      tabGroupTitle: groupName,
      tabGroupColor: groupColor
    }, (response) => {
      if (response && response.success) {
        const bookmark = allBookmarks.find(b => b.id === currentBookmarkId);
        showStatus(`Saved! "${bookmark.title}" will open in "${groupName}"`, 'success');
        document.getElementById('createGroupSection').style.display = 'none';
        document.getElementById('newGroupName').value = '';
        const greyRadio = document.getElementById('color-grey');
        if (greyRadio) greyRadio.checked = true;
        const tgSelect = document.getElementById('tabGroupSelect');
        tgSelect.value = '';
        loadTabGroups();
      } else {
        showStatus('Error saving assignment', 'error');
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
  
  const select = document.getElementById('tabGroupSelect');
  select.value = '';
  
  // Remove any "stored config" option (group deleted) since we're clearing
  for (let i = select.options.length - 1; i >= 0; i--) {
    if (select.options[i].value.startsWith('__stored__|')) {
      select.remove(i);
    }
  }
  
  updateSelectTitle(select);
  
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
