const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');

const port = process.env.PORT || 1234;
const authToken = process.env.WS_AUTH_TOKEN;
if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (conn, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = req.headers['authorization'] || url.searchParams.get('token');
    if (authToken && token !== authToken) {
        conn.close(1008, 'Invalid token');
        return;
    }
    setupWSConnection(conn, req);
});

server.listen(port, () => {
    const persist = getPersistence() ? `with persistence at ${process.env.YPERSISTENCE}` : 'without persistence';
    console.log(`ShadowLink relay server running on ws://localhost:${port} ${persist}`);
});
