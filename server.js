const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');

const port = process.env.PORT || 1234;
if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (conn, req) => {
    setupWSConnection(conn, req);
});

server.listen(port, () => {
    const persist = getPersistence() ? `with persistence at ${process.env.YPERSISTENCE}` : 'without persistence';
    console.log(`ShadowLink relay server running on ws://localhost:${port} ${persist}`);
});
