const http2 = require('http2-wrapper');
// gunzip responses
const zlib = require('zlib');

const {
	ZNC_HOSTNAME,
	NA_HOSTNAME,
	webServiceProbableSuffix
} = require('./consts.js');

// exclude these headers from BOTH responses and requests
const excludeHeaders = [
	// node will complain about Connection and Proxy-Connection
	'connection',
	'proxy-connection',
	// host header is generally forbidden when specified as request header
	'host',
	// transfer encoding is problematic in general (chunked, not compression!)
	'transfer-encoding'
];
// strip http2 pseudo headers and problematic headers above
function filterHeaders(headers) {
	// copy and delete from old array
	const filtered = headers;
	for(const name in filtered) {
		// exclude BOTH pseudo headers AND excluded headers
		if(name.startsWith(':')
		// NOTE: matches lowercase (is this superfluous though?)
		|| excludeHeaders.includes(name/*.toLowerCase()*/)
		) {
			delete filtered[name];
		}
	}
	return filtered;
}
//const https = require('https');
// agents are used to ensure connection pooling is used
// skeptical if these are useful, seems connection pools are used anyway
/*const agent = {
	https: new https.Agent({keepAlive: true}),
	http2: new http2.Agent()
};*/
// generic reverse proxy to upstream function, body is pre-read req. body
async function handleReverseProxy(req, hostname, callback, body=undefined) {
	// limit encoding to ONLY gzip!!! no funny deflate, br, zstd, etc.
	if(req.headers['accept-encoding'] !== undefined
	&& req.headers['accept-encoding'].includes('gzip')
	) {
		req.headers['accept-encoding'] = 'gzip';
	}
	// because we are only uncompressing gzip
	const request = await http2.auto({
		// NOTE: this does NOT handle hostnames w/port numbers
		// keep this in mind since this handles proxied urls
		hostname,
		path: req.url,
		method: req.method,
		headers: filterHeaders(req.headers),
		//agent
		// NOTE: not implementing upstream proxying for now, too complex.
		// it's possible to add, however proxychains works fine
		// further reading: https://github.com/szmarczak/http2-wrapper/blob/master/examples/proxies/h2-over-h1.js
	}, callback);
	//console.log('upstream request headers:', headers)
	//request.on('error', callback);
	// TODO handle errors here better!!!
	//request.on('error', console.error);

	// forward request payload/body, and end request
	if(body !== undefined) {
		// pass through pre-read body if it is there
		request.write(body);
		return request.end();
	}
	return req.pipe(request, {end: true});
}

// callback that just pipes/streams response through unmodified
const pipeResponseCallback = res => {
	// wraps this inline function bc idk how else to pass res through
	return response => {
		//console.log('response headers:', response.headers)
		// response headers can be either h2 (with pseudo headers) or h1
		res.writeHead(response.statusCode, filterHeaders(response.headers));
		// pipe body straight through unmodified
		response.pipe(res, {end: true});
		//const body = [];
		//response.on('data', chunk => body.push(chunk));
		//response.on('end', () => { res.end(Buffer.concat(body)); });
		// TODO: response.on('error', err => { etc... })
	}
}

// wrap response stream, decompressing gzip inline
const wrapCompressedResponse = (response, headers) => {
	// only supporting gzip here, not deflate/br/zstd
	// feel free to add those (or handle via a library, etc...)
	// ... but this keeps it not too demanding of dependencies
	if(headers['content-encoding'] === 'gzip') {
		// italic console color, non-standard
		console.log('\x1b[3muncompressing this response...\x1b[0m');
		const gunzip = zlib.createGunzip();
		// pass response through gzip decompressor
		response.pipe(gunzip);
		// TODO handle errors here too...???
		// return stream uncompressed from here on out
		delete headers['content-encoding'];
		return gunzip;
	}
	// otherwise return response
	return response;
}

// print access log line for use in requestHandler
function logAccess(req) {
	const timestamp = new Date().toISOString();
	const remote_ip = req.connection.remoteAddress || req.socket.remoteAddress;
	// pretty much just like in request_gamewebtoken handler
	let hostname = req.headers.origin
					? new URL(req.headers.origin).hostname
					: req.authority || req.headers.host;
	//const status_code = res.statusCode; // this is excluded for now
	const user_agent = req.headers['user-agent'] || '-';
	const scheme = req.scheme || 'http' + (req.socket.encrypted ? 's' : '');

	// neutral color that will be used to reset
	// color all access logs dim
	const neutral = '\x1b[2m';
	// color code the hostname...
	if(hostname === ZNC_HOSTNAME
	|| hostname === NA_HOSTNAME
	) {
		// nso intercept hostnames, green
		hostname = `\x1b[32m${hostname}\x1b[0m${neutral}`;
	// if a hostname ends with this, then it's most probably a web service
	} else if(hostname.endsWith(webServiceProbableSuffix)) {
		// any other nintendo.net domain (nso service), red
		hostname = `\x1b[31m${hostname}\x1b[0m${neutral}`;
	}

	console.log(`${neutral}[${timestamp}] ${remote_ip} - "${req.method} ${scheme}://${hostname}${req.url} HTTP/${req.httpVersion}" - "${user_agent}"\x1b[0m`);
}

module.exports = {
	// below is called in either callbacks within request handlers...
	filterHeaders,
	wrapCompressedResponse,
	// ... or just request handlers in general
	handleReverseProxy,
	pipeResponseCallback,
	logAccess,
};
