# ShadowLink Live Sync Testing Guide

## Fixed Issues

This update addresses critical live synchronization problems:

1. **Ghost Cursors**: Users switching documents no longer leave behind ghost cursors
2. **Cross-Document Visibility**: Users can now see each other even when working on different documents
3. **Broken Sync After Document Switch**: Synchronization now remains stable when users navigate between files
4. **Global Presence Tracking**: The plugin now tracks users across the entire vault, not just individual documents

## Key Improvements

### 1. Proper Awareness Cleanup
- **Before**: When users switched documents, their presence remained in the old document, causing ghost cursors
- **After**: Awareness state is properly cleared (`setLocalState(null)`) when switching documents

### 2. Global Vault Presence
- **Before**: Users were only visible to others on the same document
- **After**: All vault users are tracked via the metadata provider, allowing cross-document visibility

### 3. Enhanced Status Display
- **Before**: Status showed only current document users
- **After**: Status shows total vault users and lists all users with their current documents

### 4. Improved Connection Management
- **Before**: Awareness state was inconsistent between document and metadata providers
- **After**: Both providers maintain synchronized awareness state

## Testing Instructions

### Test 1: Cross-Document User Visibility

1. **Setup**: Open Obsidian with ShadowLink on two different clients
2. **Action**: Have each client open different documents
3. **Expected Result**: 
   - Both users should be visible in the ShadowLink settings panel under "Users in Vault"
   - Status bar should show total vault users (e.g., "ShadowLink: 2 users in vault")
   - Users should see each other's current document in the user list

### Test 2: No Ghost Cursors When Switching Documents

1. **Setup**: Two clients on the same document with visible cursors
2. **Action**: One user switches to a different document
3. **Expected Result**:
   - The user's cursor should disappear from the first document immediately
   - No ghost cursors should remain visible
   - The user should appear in the vault user list with their new document

### Test 3: Stable Sync After Document Changes

1. **Setup**: Two clients starting on different documents
2. **Action**: Both clients navigate to the same document and start editing
3. **Expected Result**:
   - Synchronization should work immediately without restarting Obsidian
   - Both users should see real-time changes
   - Cursors should be visible and accurately positioned

### Test 4: Persistent Vault Presence

1. **Setup**: Multiple clients connected to the vault
2. **Action**: Users switch between different documents frequently
3. **Expected Result**:
   - All users remain visible in the vault user list
   - Current document information updates correctly for each user
   - No connection drops or sync failures

## Manual Verification

Open the ShadowLink settings panel and verify:

1. **Connection Status** section shows:
   - Document connection status with current document user count
   - Vault connection with total vault user count

2. **Users in Vault** section displays:
   - All connected users with their names
   - Current document for each user
   - Clear indication of which user is "you"

## Code Changes Summary

### Core Fixes in `main.ts`:

1. **cleanupCurrent()**: Added `provider.awareness.setLocalState(null)` to clear awareness before cleanup
2. **cleanupMetadata()**: Added awareness cleanup for metadata provider
3. **ensureAwarenessState()**: Enhanced to update global vault presence
4. **connectMetadata()**: Added global awareness change monitoring
5. **handleFileOpenInternal()**: Improved awareness state transfer between documents
6. **Settings Panel**: Added real-time user list display

### Enhanced Styling in `styles.css`:

- Added user list styling for better visibility
- Clear visual distinction for current user
- Responsive layout for user information

## Troubleshooting

If sync issues persist:

1. **Check Connection**: Verify both document and vault connections in settings
2. **Restart Plugin**: Disable and re-enable ShadowLink
3. **Check Console**: Look for awareness state logs in browser console
4. **Verify Server**: Ensure WebSocket server is running and accessible

## Expected Behavior

After these fixes, ShadowLink should provide seamless real-time collaboration where:
- Users see each other regardless of which document they're working on
- Document switching doesn't break synchronization
- No ghost cursors appear when users navigate between files
- Vault-wide presence information is always available