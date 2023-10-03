"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = exports.Server = void 0;
const net = require("net");
const tls = require("tls");
const http = require("http");
const http2 = require("http2");
const events_1 = require("events");
function onError(err) { }
const TLS_HANDSHAKE_BYTE = 0x16; // SSLv3+ or TLS handshake
const HTTP2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
const HTTP2_PREFACE_BUFFER = Buffer.from(HTTP2_PREFACE);
const NODE_MAJOR_VERSION = parseInt(process.version.slice(1).split('.')[0], 10);
class Server extends net.Server {
    constructor(configOrServerOrListener, listener) {
        // We just act as a plain TCP server, accepting and examing
        // each connection, then passing it to the right subserver.
        super((socket) => this.connectionListener(socket));
        let tlsConfig;
        let tlsServer;
        let requestListener;
        if (typeof configOrServerOrListener === 'function') {
            requestListener = configOrServerOrListener;
            tlsConfig = undefined;
        }
        else if (configOrServerOrListener instanceof tls.Server) {
            tlsServer = configOrServerOrListener;
            requestListener = listener;
        }
        else {
            tlsConfig = configOrServerOrListener;
            requestListener = listener;
        }
        // We bind the request listener, so 'this' always refers to us, not each subserver.
        // This means 'this' is consistent (and this.close() works).
        const boundListener = requestListener.bind(this);
        // Create subservers for each supported protocol:
        this._httpServer = new http.Server(boundListener);
        this._http2Server = http2.createServer({}, boundListener);
        if (tlsServer) {
            // If we've been given a preconfigured TLS server, we use that directly, and
            // subscribe to connections there
            this._tlsServer = tlsServer;
            this._tlsServer.on('secureConnection', this.tlsListener.bind(this));
        }
        else if (typeof tlsConfig === 'object') {
            // If we have TLS config, create a TLS server, which will pass sockets to
            // the relevant subserver once the TLS connection is set up.
            this._tlsServer = new tls.Server(tlsConfig, this.tlsListener.bind(this));
        }
        else {
            // Fake server that rejects all connections:
            this._tlsServer = new events_1.EventEmitter();
            this._tlsServer.on('connection', (socket) => socket.destroy());
        }
        const subServers = [this._httpServer, this._http2Server, this._tlsServer];
        // Proxy all event listeners setup onto the subservers, so any
        // subscriptions on this server are fed from all the subservers
        this.on('newListener', function (eventName, listener) {
            subServers.forEach(function (subServer) {
                subServer.addListener(eventName, listener);
            });
        });
        this.on('removeListener', function (eventName, listener) {
            subServers.forEach(function (subServer) {
                subServer.removeListener(eventName, listener);
            });
        });
    }
    connectionListener(socket) {
        const data = socket.read(1);
        if (data === null) {
            socket.removeListener('error', onError);
            socket.on('error', onError);
            socket.once('readable', () => {
                this.connectionListener(socket);
            });
        }
        else {
            socket.removeListener('error', onError);
            // Put the peeked data back into the socket
            const firstByte = data[0];
            socket.unshift(data);
            // Pass the socket to the correct subserver:
            if (firstByte === TLS_HANDSHAKE_BYTE) {
                // TLS sockets don't allow half open
                socket.allowHalfOpen = false;
                this._tlsServer.emit('connection', socket);
            }
            else {
                if (firstByte === HTTP2_PREFACE_BUFFER[0]) {
                    // The connection _might_ be HTTP/2. To confirm, we need to keep
                    // reading until we get the whole stream:
                    this.http2Listener(socket);
                }
                // NOTE: MONKEY PATCH FOR nso-reverse2
                else if (firstByte === 0x43) {
                    // ASCII "C", handle CONNECT - only method that begins with C.
                    // Read the whole request, ignoring who to connect to.
                    socket.read();
                    // Send back connection established message
                    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
                    socket.allowHalfOpen = false;
                    // Pass back to TLS handler (Client sent ClientHello)
                    this._tlsServer.emit('connection', socket);
                }
                else {
                    // The above unshift isn't always sufficient to invisibly replace the
                    // read data. The rawPacket property on errors in the clientError event
                    // for plain HTTP servers loses this data - this prop makes it available.
                    // Bit of a hacky fix, but sufficient to allow for manual workarounds.
                    socket.__httpPeekedData = data;
                    this._httpServer.emit('connection', socket);
                }
            }
        }
    }
    tlsListener(tlsSocket) {
        if (tlsSocket.alpnProtocol === false || // Old non-ALPN client
            tlsSocket.alpnProtocol === 'http/1.1' || // Modern HTTP/1.1 ALPN client
            tlsSocket.alpnProtocol === 'http 1.1' // Broken ALPN client (e.g. https-proxy-agent)
        ) {
            this._httpServer.emit('connection', tlsSocket);
        }
        else {
            this._http2Server.emit('connection', tlsSocket);
        }
    }
    http2Listener(socket, pastData) {
        const h1Server = this._httpServer;
        const h2Server = this._http2Server;
        const newData = socket.read() || Buffer.from([]);
        const data = pastData ? Buffer.concat([pastData, newData]) : newData;
        if (data.length >= HTTP2_PREFACE_BUFFER.length) {
            socket.unshift(data);
            if (data.slice(0, HTTP2_PREFACE_BUFFER.length).equals(HTTP2_PREFACE_BUFFER)) {
                // We have a full match for the preface - it's definitely HTTP/2.
                // For HTTP/2 we hit issues when passing non-socket streams (like H2 streams for proxying H2-over-H2).
                if (NODE_MAJOR_VERSION <= 12) {
                    // For Node 12 and older, we need a (later deprecated) stream wrapper:
                    const StreamWrapper = require('_stream_wrap');
                    socket = new StreamWrapper(socket);
                }
                else {
                    // For newer node, we can fix this with a quick patch here:
                    const socketWithInternals = socket;
                    if (socketWithInternals._handle) {
                        socketWithInternals._handle.isStreamBase = false;
                    }
                }
                h2Server.emit('connection', socket);
                return;
            }
            else {
                h1Server.emit('connection', socket);
                return;
            }
        }
        else if (!data.equals(HTTP2_PREFACE_BUFFER.slice(0, data.length))) {
            socket.unshift(data);
            // Haven't finished the preface length, but something doesn't match already
            h1Server.emit('connection', socket);
            return;
        }
        // Not enough data to know either way - try again, waiting for more:
        socket.removeListener('error', onError);
        socket.on('error', onError);
        socket.once('readable', () => {
            this.http2Listener.call(this, socket, data);
        });
    }
}
exports.Server = Server;
function createServer(configOrServerOrListener, listener) {
    return new Server(configOrServerOrListener, listener);
}
exports.createServer = createServer;
;
//# sourceMappingURL=index.js.map
