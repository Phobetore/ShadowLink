const http = require('http');
const WebSocket = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils.js');

const port = process.env.PORT || 1234;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (conn, req) => {
    setupWSConnection(conn, req);
});

server.listen(port, () => {
    console.log(`ShadowLink relay server running on ws://localhost:${port}`);
});
