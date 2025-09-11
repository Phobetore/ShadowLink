#!/usr/bin/env node

/**
 * Test script to validate file switching behavior
 * This simulates the scenario described in the issue
 */

const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

console.log('🧪 Testing ShadowLink file switching behavior...\n');

// Simulate two clients and file switching
async function testFileSwitch() {
    const serverUrl = 'ws://localhost:1234';
    const vaultId = 'test-vault-123';
    const userId1 = 'user-1';
    const userId2 = 'user-2';
    
    console.log('1. Creating client 1 and connecting to note A...');
    
    // Client 1 - starts on Note A
    const client1_noteA_doc = new Y.Doc();
    const client1_noteA_provider = new WebsocketProvider(
        serverUrl, 
        `${vaultId}/noteA.md`, 
        client1_noteA_doc,
        { params: { vaultId, userId: userId1 } }
    );
    
    const client1_noteA_text = client1_noteA_doc.getText('content');
    
    // Wait for connection
    await new Promise((resolve) => {
        client1_noteA_provider.on('status', (event) => {
            if (event.status === 'connected') {
                console.log('✅ Client 1 connected to Note A');
                resolve();
            }
        });
    });
    
    // Client 1 adds content to Note A
    client1_noteA_text.insert(0, 'Hello from Client 1 on Note A!');
    console.log('📝 Client 1 added content to Note A');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\n2. Creating client 2 and connecting to note A...');
    
    // Client 2 - also starts on Note A
    const client2_noteA_doc = new Y.Doc();
    const client2_noteA_provider = new WebsocketProvider(
        serverUrl, 
        `${vaultId}/noteA.md`, 
        client2_noteA_doc,
        { params: { vaultId, userId: userId2 } }
    );
    
    const client2_noteA_text = client2_noteA_doc.getText('content');
    
    // Wait for client 2 connection and sync
    await new Promise((resolve) => {
        client2_noteA_provider.on('sync', () => {
            console.log('✅ Client 2 connected and synced to Note A');
            console.log('📄 Client 2 sees content:', client2_noteA_text.toString());
            resolve();
        });
    });
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\n3. Client 1 switches to Note B (this is where the bug occurs)...');
    
    // Client 1 switches to Note B - this is the problematic scenario
    const client1_noteB_doc = new Y.Doc();
    const client1_noteB_provider = new WebsocketProvider(
        serverUrl, 
        `${vaultId}/noteB.md`, 
        client1_noteB_doc,
        { params: { vaultId, userId: userId1 } }
    );
    
    const client1_noteB_text = client1_noteB_doc.getText('content');
    
    // Clean up Note A connection (simulating file switch)
    client1_noteA_provider.destroy();
    client1_noteA_doc.destroy();
    
    await new Promise((resolve) => {
        client1_noteB_provider.on('status', (event) => {
            if (event.status === 'connected') {
                console.log('✅ Client 1 connected to Note B');
                resolve();
            }
        });
    });
    
    // Client 1 adds content to Note B
    client1_noteB_text.insert(0, 'Hello from Client 1 on Note B!');
    console.log('📝 Client 1 added content to Note B');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\n4. Client 2 switches to Note B...');
    
    // Client 2 also switches to Note B
    const client2_noteB_doc = new Y.Doc();
    const client2_noteB_provider = new WebsocketProvider(
        serverUrl, 
        `${vaultId}/noteB.md`, 
        client2_noteB_doc,
        { params: { vaultId, userId: userId2 } }
    );
    
    const client2_noteB_text = client2_noteB_doc.getText('content');
    
    // Clean up Note A connection for client 2
    client2_noteA_provider.destroy();
    client2_noteA_doc.destroy();
    
    await new Promise((resolve) => {
        client2_noteB_provider.on('sync', () => {
            console.log('✅ Client 2 connected and synced to Note B');
            console.log('📄 Client 2 sees content:', client2_noteB_text.toString());
            resolve();
        });
    });
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\n5. Testing live sync on Note B...');
    
    // Test if live sync still works after file switching
    client2_noteB_text.insert(client2_noteB_text.length, '\nAdding from Client 2!');
    console.log('📝 Client 2 added content to Note B');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const client1_content = client1_noteB_text.toString();
    const client2_content = client2_noteB_text.toString();
    
    console.log('\n📊 Final Results:');
    console.log('Client 1 content:', client1_content);
    console.log('Client 2 content:', client2_content);
    
    if (client1_content === client2_content && client1_content.includes('Client 1') && client1_content.includes('Client 2')) {
        console.log('✅ SUCCESS: Live sync works after file switching!');
    } else {
        console.log('❌ FAILURE: Live sync broken after file switching');
    }
    
    // Cleanup
    client1_noteB_provider.destroy();
    client1_noteB_doc.destroy();
    client2_noteB_provider.destroy(); 
    client2_noteB_doc.destroy();
    
    console.log('\n🧹 Cleaned up test connections');
}

// Run the test
testFileSwitch().catch(console.error);