const httpolyglot = require('@httptoolkit/httpolyglot');
// open certs and js inject file
const { readFileSync } = require('fs');
// cache directory
const { tmpdir } = require('os');

// ad-hoc functions that help out with reverse proxying
const {
	filterHeaders,
	wrapCompressedResponse,
	handleReverseProxy,
	pipeResponseCallback,
	logAccess,
} = require('./reverse-proxy-helpers.js');

const {
	nxapiInit,
	setCachedWebServiceToken,
	getWebServiceToken,
	// handlers?
	getTokenInterceptHandler,
} = require('./nxapi.js');

const persistentCache = require('persistent-cache');
const cache = persistentCache({
	// creates a "cache" folder here (meant to persist until reboot only!!!)
	base: tmpdir(),
	name: 'nso-reverse2',
	// this framework injects a "cacheUntil" property into cached objects
	// but it does not let you set it yourself so if it weren't for that
	// then we could just avoid any code involving expiresIn entirely but NOPE
	//duration: 1000 * 3600 * 24 //one day
});
// defined by nxapiInit
let webServiceMap, naURLParts;
// js file to inject into web service pages
// so that they can store persistent data and refresh tokens
// this has a js extension for the purposes of syntax highlighting
const webServiceJsInject = readFileSync(__dirname + '/web-service-js-inject.js');

// callback used on all web service pages
const webServiceCallback = res => {
	return response => {
		let headers = filterHeaders(response.headers);
		//console.log(`content type!!!: ${headers['content-type']}`)
		// content type includes text/html
		const pageIsHTML = headers['content-type'] !== undefined
		&& headers['content-type'].includes('text/html')
		// don't inject script if it's undefined, i.e failed to open
		if(pageIsHTML && webServiceJsInject !== undefined) {
			console.log(`html endpoint: ${response.url}`)
			// will cause discrepancies so remove old length
			delete headers['content-length'];
			// when this is true, the stream is passed w/o replacement
			let replaced = false;
			// read response, uncompressing gzip
			const stream = wrapCompressedResponse(response, headers);
			res.writeHead(response.statusCode, headers);

			stream.on('data', chunk => {
				// just write chunk as-is if replacement is done
				if(replaced)
					return res.write(chunk);
				const chunkStr = chunk.toString();
				// we want to inject basically just after head...
				const index = chunkStr.indexOf('<head>');
				if(index === -1)
					return res.write(chunk);
				replaced = true;
				// write everything before the head
				//res.write(chunkStr.substring(0, index));
				// write the file...
				res.write(webServiceJsInject);
				// write chunk after head
				res.write(chunkStr.substring(index + 6)); // length of <head>
			});
			stream.on('end', () => res.end());
		} else {
			res.writeHead(response.statusCode, headers);
			// otherwise pass through body unmodified
			response.pipe(res, {end: true});
		}
	}
}

// coral api callback buffers response body so set a maximum size
const MAX_RESPONSE_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

const coralAPIInterceptionHandlers = {
	'/Game/GetWebServiceToken': (data, reqBodyObj, {}) => {
		//console.log('\x1b[1mMMM MMM MMMM COME GET YOUR WEBSERVICETOKEN RIGHT HERE!!!!!!!!!!\x1b[0m:\n', data)
		// id of web service
		const webserviceID = reqBodyObj['parameter']['id'];
		//const webserviceID = 4834290508791808
		// sometimes response is an error and there is no result
		if(data.result !== undefined) {
			setCachedWebServiceToken(webserviceID, data.result);
			console.log(`set webservicetoken cache for id: \x1b[1m{webserviceID}\x1b[0m...`);
		} else {
			console.log('GetWebServiceToken response does not have result...');
		}
	},
	// defined separately in nxapi handlers
	'/Account/GetToken': getTokenInterceptHandler,
	// on accounts.nintendo.com because the same callback is used!
	'/connect/1.0.0/api/token': (data, {}, {}) => {
		// don't set cache if there is no access token
		// NOTE i don't actually know the format for if there is an error
		if(data.access_token === undefined) {
			console.log('no access token in nintendo account response...???');
			return;
		}
		console.log('set nintendo account token cache...');
		// async once again (NO CALLBACK) ... NOTE: may cause race condition?
		cache.put('latest-na-token-response', data, ()=>{});
	}
}

// intercept tokens, etc. from coral ("znc") api
const coralAPICallback = (res, reqBody, interceptionHandler) => {
	return response => {
		let headers = filterHeaders(response.headers);

		// TODO update comments here
		// handle decompression (response is uncompressed!)
		const stream = wrapCompressedResponse(response, headers);
		res.writeHead(response.statusCode, headers);

		// buffer ENTIRE response!! will cancel if it is big
		const body = [];
		let bodySize = 0;
		stream.on('data', chunk => {
			bodySize += chunk.length;
			if(bodySize > MAX_RESPONSE_BODY_SIZE) {
				// end without any feedback to the response...
				console.error('response body too large...?:', bodySize)
				res.writeHead(413);
				res.end(`response body size ${bodySize}, maximum ${MAX_RESPONSE_BODY_SIZE}`);
				// TODO TEST THIS BC I M NOT CONVINCED THAT THIS WORKS
				return stream.destroy();
			}
			body.push(chunk)
		});
		stream.on('end', () => {
			const bodyBuf = Buffer.concat(body);
			res.end(bodyBuf);
			// buffer response out first, continue processing here
			let bodyObj;
			try {
				// ALWAYS decode json reponse - NOTE: no empty check!
				bodyObj = JSON.parse(bodyBuf);
			} catch(e) {
				console.error('FAILURE WHEN DECODING JSON RESPONSE IN CORAL API INTERCEPTION:', e)
				return;
			}

			// TODO error check all of this
			const reqBodyStr = reqBody.toString();
			let reqBodyObj;
			// check that request body length is not falsey
			if(reqBodyStr.length
			// .. and json content type is actually set
			&& res.req.headers['content-type'].includes('json')
			) {
				reqBodyObj = JSON.parse(reqBodyStr);
			}
			// req from response object should be identical
			interceptionHandler(bodyObj, reqBodyObj, res.req);
		});
		// TODO: response.on('error', err => { etc... })
	}
}

// requests over this size will stop being buffered
const MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

const ZNC_HOSTNAME = 'api-lp1.znc.srv.nintendo.net';
const NA_HOSTNAME = 'accounts.nintendo.com';
async function requestHandler(req, res) {
	// test if this is an http proxy request and not a normal one
	if(req.url[0] !== '/') {
		let url = new URL(req.url);
		// set custom property authority to the real hostname
		// NOTE: url.host contains port while url.hostname does not
		req.authority = url.hostname;
		req.url = url.pathname;
	}
	logAccess(req);
	if(req.url === '/_/request_gamewebtoken') {
		// cors headers required because this will be fetched
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Private-Network': 'true',
		};
		if(req.method === 'OPTIONS') {
			// end abruptly on options because. yknow
			res.writeHead(200, corsHeaders);
			return res.end();
		}
		// used to search for web service id
		// origin will contain protocol/scheme so strip it
		const hostname = req.headers.origin
		? new URL(req.headers.origin).hostname
		// these should not (they may contain ports though!)
		: req.authority || req.headers.host;
		// find service based on if uri includes hostname
		//const service = webServices.find(s => s.uri.includes(hostname));
		// if service was found...
		if(webServiceMap.has(hostname)) {
			const serviceID = webServiceMap.get(hostname)
			getWebServiceToken(serviceID).then(token => {
				//encodedResponse = JSON.stringify(token)
				res.writeHead(200, corsHeaders);
				res.write(token);
			}).catch(err => {
				res.writeHead(500, corsHeaders);
				console.error(`Error while fetching token at ${new Date()}:\n`, err);
				// respond with backtrace
				res.write(err.stack);
			}).finally(() => {
				res.end();
			});
			return;
		}
		//return res.end(`http${(req.socket.encrypted ? 's' :'')} at ${req.socket.servername} with path ${req.url}`);
	}
	// req.socket.servername is not available on http2 (?)
	// but req.authority is only on http2, host header is only on http1
	const hostname = req.authority || req.headers.host;
	// reverse proxy to znc api to intercept various tokens
	if(hostname === ZNC_HOSTNAME
	|| hostname === NA_HOSTNAME
	) {
		// TODO: selectively buffer based on url?? but then you have to choooos
		const interceptedEndpoint = Object.keys(coralAPIInterceptionHandlers)
									.find(endpoint => req.url.includes(endpoint));
		if(interceptedEndpoint !== undefined) {
			// buffer request body in if interception is happening
			const reqBody = [];
			let bodySize = 0;
			req.on('data', chunk => {
				bodySize += chunk.length;
				if(bodySize > MAX_REQUEST_BODY_SIZE) {
					// end immediately if we are buffering a big request body
					console.error('request body too large...?:', bodySize)
					res.writeHead(413);
					res.end('o-onii chan, i-it\'s too big...');
					return req.destroy();
				}
				reqBody.push(chunk)
			});
			req.on('end', () => {
				// pass request body to both so it can be passed upstream
				const bodyBuf = Buffer.concat(reqBody);
				const interceptionHandler = coralAPIInterceptionHandlers[interceptedEndpoint];
				const callback = coralAPICallback(res, bodyBuf, interceptionHandler);
				handleReverseProxy(req, hostname, callback, bodyBuf);
			});
			return;
		}
		// if not interceptable, then pass right through
		return handleReverseProxy(req, hostname, pipeResponseCallback(res));
	}
	// if the hostname is a web service...
	if(webServiceMap.has(hostname)) {
		const serviceID = webServiceMap.get(hostname);
		// check if we should inject a token into req headers
		// it should be injected on / or with query parameters

		// inject language parameters into url (causes nooklink to not load if omitted)
		if(req.url === '/') {
			// detect browser language
			const acceptLanguage = req.headers['accept-language'];
			// default language...
			let lang = 'en-US';
			if(acceptLanguage !== undefined) {
				// select first language in accept-language list
				lang = acceptLanguage.split(',')[0];
			}
			// naURLParts is generated in nxapiInit
			const redirectTo = '/?lang=' + lang + naURLParts;
			// redirect and return
			res.writeHead(302, { 'Location': redirectTo });
			return res.end();
		}
		// real handler, index with query param
		if(req.url.startsWith('/?')) {
			// fetch and inject gamewebtoken here...!
			const token = await getWebServiceToken(serviceID)
			/*.catch(err => {
				console.error(`Error while fetching token pre-request at ${new Date()}:\n`, err);
			});*/
			if(token)
				req.headers['x-gamewebtoken'] = token;
			// needed or else it would cause issues with nooklink
			req.headers['dnt'] = '0';
			req.headers['x-appcolorscheme'] = 'LIGHT';
			// NOTE: potentially superfluous headers above?
		}
		// use our callback to always intercept and check response headers
		return handleReverseProxy(req, hostname, webServiceCallback(res));
	}
	/* for testing..!!
	if(hostname === 'ipinfo.io'
	|| hostname === 'mii-secure.cdn.nintendo.net'
	|| hostname === 'quic.rocks:4433'
	|| hostname === 'accounts.nintendo.com'
	) {
		return handleReverseProxy(req, hostname, pipeResponseCallback(res));
	}*/
	res.writeHead(404, {'Content-Type': 'text/html'});
	res.end(`<pre style=text-wrap:wrap>where are you? are you lost? here's some anime feet to help you get back on track:
<img src="https://pbs.twimg.com/media/F4_waFgaEAA1gzw.jpg"style=height:100%>`);
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

// yargs is included with nxapi
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// use yargs to define server params
//, as well as usernsid
const argv = yargs(hideBin(process.argv))
	.option('host', { default: 'localhost' })
	.option('port', { type: 'number', default: 8443 })
	.option('key', { default: __dirname + '/nintendo-net.key' })
	.option('cert', { default: __dirname + '/nintendo-net.pem' })
	// TODO IMPLEMENT THIS IMPLEMENT THIS IMPLEM
	/*.option('usernsid', {
		description: 'usernsid passed to nxapi instead of stored one',
	})*/
	.command('make-san', 'this will make a san.txt that you can use to generate certs. just run it, i\'ll explain everything')
	.help()
	.argv;

// do nxapi init FIRST!
nxapiInit(cache).then(initParams => {
	webServiceMap = initParams.webServiceMap;
	naURLParts = initParams.naURLParts;
	// TODO: finish this, print out a san.txt usable for signing certificates and FULL INSTRUCTIONS with openssl on how to do this!!
	if(argv['_'][0] === 'make-san') {
		const hostnameMap = [...webServiceMap.keys(), ZNC_HOSTNAME, NA_HOSTNAME];
		const sans = 'subjectAltName=DNS:'
		+ hostnameMap.join(',DNS:');
		console.log('\n\n')
		console.error(sans);
		console.log('\n\n\x1b[1mopen your ssl\x1b[0m');
		return;
	}
	// NOTE: THIS LIB IS MONKEY PATCHED (import at top)
	const server = httpolyglot.createServer({
		// self-signed certs representing "*.nintendo.net"
		key: readFileSync(argv.key),
		cert: readFileSync(argv.cert),
		// without this the server will not serve http2
		ALPNProtocols: ['h2', 'http/1.1']
	}, requestHandler);//errorHandlerWrapper(requestHandler))
	// resolve HTTP CONNECT to httpolyglot handler (probably as TLS)
	server.on('connect', (_, socket) => {
		socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
		// Recurse back and handle TLS (Client sent ClientHello)
		socket._server.connectionListener(socket);
	})
	if(process.env.LISTEN_FDS) {
		// handle systemd socket (VERY USE CASE SPECIFIC)
		const { getListenArgs } = require('@derhuerst/systemd');
		return server.listen(...getListenArgs(), () => {
			console.log('server listening on systemd socket!!');
		});
	}
	server.listen(argv.port, argv.host, () => {
		console.log(`now listening on ${argv.host}:${argv.port}`);
	});
});

