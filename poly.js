const httpolyglot = require('@httptoolkit/httpolyglot');
const fs = require('fs');

//const fetch = require('fetch-h2').fetch;
const http2 = require('http2-wrapper');

// exclude these headers from responses and h2 requests
const excludeHeaders = [
	//'transfer-encoding',
	// node will complain if the Connection header remains
	'connection'
];
// strip pseudo headers for http2 requests and responses
function filterHttp2PseudoHeaders(headers) {
	/*const filtered = {};
	for(let key of Object.keys(headers)) {
		if(!key.startsWith(':')) {
			filtered[key] = headers[key];
		}
	}*/
	const filtered = headers;
	for(const name in filtered) {
		// exclude BOTH pseudo headers AND excluded headers
		if(name.startsWith(':')
		|| excludeHeaders.includes(name.toLowerCase())
		) {
			delete filtered[name];
		}
	}
	return filtered;
}
async function handleReverseProxy(req, hostname, callback) {
	// only filter pseudo headers on http 2
	const headers = req.httpVersionMajor === 2
					? filterHttp2PseudoHeaders(req.headers)
					: req.headers
	// causes an http2 error and should not cause an issue
	// also i think the headers are always lowercase in http2
	delete headers['host']
	// TODO add functionality here that will make it so...
	// ... that if there is Accept-Encoding with values, make it only gzip
	// because we are only uncompressing gzip
	const request = await http2.auto({
		// if hostname has port number it WILL NOT WORK!
		// keep this in mind around handling proxied url
		hostname,
		path: req.url,
		method: req.method,
		headers
	}, callback);
	//console.log('request headers:', headers)
	//request.on('error', callback);
	//request.on('error', console.error);

	// forward request payload/body, and end request
	req.pipe(request, {end: true});
}

// callback that just pipes/streams response through unmodified
const pipeResponseCallback = response => {
	//console.log('response headers:', response.headers)
	// filter pseudo headers here because it can be h2 or h1
	res.writeHead(response.statusCode, filterHttp2PseudoHeaders(response.headers));
	// pipe body RIGHT thru!
	response.pipe(res, {end: true});
	//const body = [];
	//response.on('data', chunk => body.push(chunk));
	//response.on('end', () => { res.end(Buffer.concat(body)); });
}

async function requestHandler(req, res) {
	if(req.url === '/_/request_gamewebtoken') {
		// cors headers required because this will be fetched
		res.writeHead(200, {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Private-Network': 'true',
		});
		if(req.method === 'OPTIONS')
			// end abruptly on options because. yknow
			return res.end();
		return res.end(`http${(req.socket.encrypted ? 's' :'')} at ${req.socket.servername} with path ${req.url}`);
	}
	// test if this is an http proxy request and not a normal one
	if(req.url[0] !== '/') {
		let url = new URL(req.url);
		// set custom property authority to the real hostname
		// NOTE: url.host contains port while url.hostname does not
		req.authority = url.hostname;
		req.url = url.pathname;
	}
	// req.socket.servername is not available on http2 (?)
	// but req.authority is only on http2, host header is only on http1
	const hostname = req.authority || req.headers.host;
	console.log(`request with hostname: ${hostname}`)
	// reverse proxy to znc api to intercept various tokens
	/*if(hostname === 'api-lp1.znc.srv.nintendo.net') {
		await handleReverseProxy(req, res, hostname);
		if(req.url.contains('/Game/GetWebServiceToken')) {
		}
	}*/
	if(hostname === 'ipinfo.io'
	|| hostname === 'mii-secure.cdn.nintendo.net'
	|| hostname === 'quic.rocks:4433'
	) {
		handleReverseProxy(req, hostname, pipeResponseCallback);
		return;
	}
	res.writeHead(404, {'Content-Type': 'text/html'});
	res.end(`<pre style=text-wrap:wrap>where are you? are you lost? here's some anime feet to help you get back on track:\n<img src="https://pbs.twimg.com/media/F4_waFgaEAA1gzw.jpg"style=height:100%>`);
}

process.on('uncaughtException', err => {
	// highlights in red and ends at colon
	console.error(`\x1b[31mUnhandled error at ${new Date()}\x1b[0m:\n`, err);
});
/*function errorHandlerWrapper(handler) {
	return (req, res) => {
		/*try {
			handler(req, res);
		} catch (error) {
			console.error('Error caught within the server:', error);
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('Internal Server Error: ' + error);
		}
		new Promise((resolve, reject) => {
			handler(req, res);
			resolve();
		}).catch(err => {
			console.error('Error in server:', err);
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('Internal Server Error: ' + error);
		});
	};
}*/
const server = httpolyglot.createServer({
	// self-signed certs representing "*.nintendo.net"
	key: fs.readFileSync('nintendo-net.key'),
	cert: fs.readFileSync('nintendo-net.pem'),
	// without this the server will not serve http2
	ALPNProtocols: ['h2', 'http/1.1']
}, requestHandler)//errorHandlerWrapper(requestHandler))
.listen(8443/*, '127.0.0.1', () => {
	console.log('listening');
}*/);


