const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');

const port = process.env.PORT || 1234;
if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}
const useTls = process.env.SSL_KEY && process.env.SSL_CERT;

let server;
if (useTls) {
    const options = {
        key: fs.readFileSync(process.env.SSL_KEY),
        cert: fs.readFileSync(process.env.SSL_CERT)
    };
    server = https.createServer(options);
} else {
    server = http.createServer();
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (conn, req) => {
    setupWSConnection(conn, req);
});

server.listen(port, () => {
    const protocol = useTls ? 'wss' : 'ws';
    const persist = getPersistence()
        ? `with persistence at ${process.env.YPERSISTENCE}`
        : 'without persistence';
    console.log(`ShadowLink relay server running on ${protocol}://localhost:${port} ${persist}`);
});
