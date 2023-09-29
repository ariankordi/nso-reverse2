const httpolyglot = require('@httptoolkit/httpolyglot');
const fs = require('fs');
// for tmpdir
const os = require('os');
const path = require('path');

const http2 = require('http2-wrapper');
// for making an agent
const https = require('https');

const persistentCache = require('persistent-cache');
const cache = persistentCache({
	// creates a "cache" folder here (meant to persist until reboot!!!)
	base: os.tmpdir(),
	name: 'nso-reverse2',
	// this framework injects a "cacheUntil" property into cached objects
	// but it does not let you set it yourself so if it weren't for that
	// then we could just avoid any code involving expiresIn entirely but NOPE
	//duration: 1000 * 3600 * 24 //one day
});
let paths, getToken, initStorage;
let /*webServices, */webServiceMap;
async function nxapiInit() {
	// required to make http_proxy work here
	const { setGlobalDispatcher } = require('undici');

	const nxapiExport = require.resolve('nxapi');
	// import() for paths within nxapi dist..!!
	const nxapiInternal = m => import(path.join(nxapiExport, '../../' + m));
    await Promise.all([
        nxapiInternal('util/undici-proxy.js').then(m => {
			// handle setting http proxy
			// NOTE: ONLY NXAPI REQUESTS WILL BE PROXIED!!!!!!!
			// http2-wrapper seemingly does not support http proxies
			const agent = m.buildEnvironmentProxyAgent();
			setGlobalDispatcher(agent);
			// handle if it fails because nxapi 1.6.1 does not have this
		}).catch(err => {
			console.error('could not load undici-proxy.js, nxapi will not pass through HTTP_PROXY:\n', err);
		}),
        nxapiInternal('util/useragent.js').then(m => {
			// add user agent just like nxapi cli does it
			m.addUserAgent('nxapi-cli');
			if(process.env.NXAPI_USER_AGENT) {
				m.addUserAgent(process.env.NXAPI_USER_AGENT);
			}
		}),
		// better way to do these????
        nxapiInternal('util/storage.js').then(m => {
			paths = m.paths
			initStorage = m.initStorage
		}),
        nxapiInternal('common/auth/coral.js').then(m => {getToken = m.getToken})
    ]).then(async () => {
		// THEN fetch web services, this is where errors will happen
		console.log('nxapi loaded, fetching web services...');
		// TODO UTILIZE CachedWebServicesList: https://github.com/samuelthomas2774/nxapi/blob/c5d8d25334d4823566611195f2d106d49e63401b/src/app/main/menu.ts#L139
		const storage = await initStorage(paths.data);
		const usernsid = await storage.getItem('SelectedUser');
		const token = await storage.getItem('NintendoAccountToken.' + usernsid);
		const { nso, data } = await getToken(storage, token);
		// get language so we can find a cached version
		const language = data.user.language
		let webServices;
		const webServicesCacheKey = 'CachedWebServicesList.' + language;
		const webServicesCached = await storage.getItem(webServicesCacheKey);
		if(webServicesCached) {
			// use cached version...
			webServices = webServicesCached.webservices
		} else {
			// ... otherwise fetch if cached version doesn't work
			webServices = await nso.getWebServices();
			// store it but without sync so there is a promise that can FAIL!
			storage.setItem(webServicesCacheKey, {
				webservices: webServices,
				updated_at: Date.now(),
				language: data.user.language,
				user: data.user.id,
			});
		}
		console.log(`\x1b[32msuccessfully fetched ${webServices.length} web services from ${webServicesCached ? 'from cache' : 'getWebServices()'}\x1b[0m`);
		// make a map of webservices where...
		// key is hostname and value is the ID
		webServiceMap = webServices.reduce((obj, service) => {
			const hostname = new URL(service.uri).hostname;
			obj[hostname] = service.id;
			return obj;
		}, {});
	});
}

async function getWebServiceToken(webserviceID) {
	// redo getting storage and user all over again
	// ... but this stuff SHOULD be cached.
	const storage = await initStorage(paths.data);
	const usernsid = await storage.getItem('SelectedUser');
	const token = await storage.getItem('NintendoAccountToken.' + usernsid);
	const { nso } = await getToken(storage, token);
	// get servicetoken from cache or not!!!!
	const cacheKey = `WebServiceToken.${usernsid}.${webserviceID}`;
	const cacheResult = cache.getSync(cacheKey);
	if(cacheResult && cacheResult.tokenExpiry > Date.now()) {
		console.log(`fetched token for ${webserviceID} from cache`);
		return cacheResult.accessToken;
	}
	//if(cacheResult.tokenExpiry < Date.now()) { console.log('cache expired...') }
	let webServiceToken = await nso.getWebServiceToken(webserviceID);
	// expiresIn is merely a unit of time of how long the token lasts
	// add tokenExpiry to the webServiceToken object...!!
	webServiceToken.tokenExpiry = Date.now() + (webServiceToken.expiresIn * 1000);
	// store cache async, no-op when done
	cache.put(cacheKey, webServiceToken, () => {});
	console.log(`fetched token for ${webserviceID} from getWebServiceToken()`);
	return webServiceToken.accessToken;
}


// exclude these headers from responses and h2 requests
const excludeHeaders = [
	//'transfer-encoding',
	// node will complain if the Connection header remains
	// TODO RE EVALUATE THESE bc filtering is req/res specific
	'connection',
	'proxy-connection',
	'host',
	'transfer-encoding'
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
// agents enable connection pools hence the whole point of h2
/*const agent = {
	https: new https.Agent({keepAlive: true}),
	http2: new http2.Agent({keepAlive: true})
};
*/
async function handleReverseProxy(req, hostname, callback) {
	// only filter pseudo headers on http 2
	// NOTE: removing pseudo headers before calling:
	// things like .url, .method, .authority, etc. breaks them
	/*const headers = req.httpVersionMajor === 2
					? filterHttp2PseudoHeaders(req.headers)
					: req.headers
	*/
	// causes an http2 error and should not cause an issue
	// also i think the headers are always lowercase in http2
	//delete headers['host']
	// TODO add functionality here that will make it so...
	// ... that if there is Accept-Encoding with values, make it only gzip
	// because we are only uncompressing gzip
	const request = await http2.auto({
		// if hostname has port number it WILL NOT WORK!
		// keep this in mind around handling proxied url
		hostname,
		path: req.url,
		method: req.method,
		headers: filterHttp2PseudoHeaders(req.headers),
		//agent
	}, callback);
	//console.log('request headers:', headers)
	//request.on('error', callback);
	// TODO handle errors here better!!!
	//request.on('error', console.error);

	// forward request payload/body, and end request
	req.pipe(request, {end: true});
}

// callback that just pipes/streams response through unmodified
const pipeResponseCallback = res => {
	// actually a function wrapper
	return response => {
		//console.log('response headers:', response.headers)
		// filter pseudo headers here because it can be h2 or h1
		res.writeHead(response.statusCode, filterHttp2PseudoHeaders(response.headers));
		// pipe body RIGHT thru!
		response.pipe(res, {end: true});
		//const body = [];
		//response.on('data', chunk => body.push(chunk));
		//response.on('end', () => { res.end(Buffer.concat(body)); });
	}
}

// js file to inject into web service pages
// so that they can store persistent data and refresh tokens
const webServiceJsInject = fs.readFileSync('/home/arian/Downloads/nso reverse proxy/bruh.js');

async function requestHandler(req, res) {
	// test if this is an http proxy request and not a normal one
	if(req.url[0] !== '/') {
		let url = new URL(req.url);
		// set custom property authority to the real hostname
		// NOTE: url.host contains port while url.hostname does not
		req.authority = url.hostname;
		req.url = url.pathname;
	}
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
		const serviceID = webServiceMap[hostname]
		// if service was found...
		if(serviceID !== undefined) {
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
	console.log(`[${new Date().toISOString()
}] request with hostname: ${hostname}`)
	// reverse proxy to znc api to intercept various tokens
	/*if(hostname === 'api-lp1.znc.srv.nintendo.net') {
		await handleReverseProxy(req, res, hostname);
		if(req.url.contains('/Game/GetWebServiceToken')) {
		}
	}*/
	const serviceID = webServiceMap[hostname];
	// if the hostname is a web service...
	if(serviceID !== undefined) {
		// check if we should inject a token into req headers
		// it should be injected on / or with query parameters
		if(req.url === '/' || req.url.startsWith('/?')) {
			// fetch and inject gamewebtoken here...!
			const token = await getWebServiceToken(serviceID)
			/*.catch(err => {
				console.error(`Error while fetching token pre-request at ${new Date()}:\n`, err);
			});*/
			if(token)
				req.headers['X-GameWebToken'] = token;
			// TODO TEST WITH NOOKLINK AND SEE IF THIS IS SUPERFLUOUS
			// TEST TO SEE IF YOU NEED TO DO THIS FOR ALL REQUESTS
			// NOTE ALSO ADD X-AppColorScheme
			// needed or else it would cause issues with nooklink
			req.headers['dnt'] = '0';
		}
		// always intercept to check response header
		const callback = response => {
			let headers = filterHttp2PseudoHeaders(response.headers);
			//console.log(`content type!!!: ${headers['content-type']}`)
			const pageIsHTML = headers['content-type'] === 'text/html';
			// use this in case it has charset utf-8 in the type
			/*const pageIsHTML == headers['content-type'] !== undefined
			&& headers['content-type'].includes('text/html')
			*/
			// don't inject script if it's undefined, i.e failed to open
			if(pageIsHTML && webServiceJsInject !== undefined) {
				console.log(`html endpoint: ${response.url}`)
				// TODO HANDLE DECOMPRESSION HERE
				const body = [];
				response.on('data', chunk => body.push(chunk));
				response.on('end', () => {
					// will cause discrepancies so remove old length
					delete headers['content-length']
					res.writeHead(response.statusCode, headers);
					// at the moment, read the whole body into a buffer
					let bodyBuf = Buffer.concat(body).toString();
					// then replace instance of <head> with our file
					bodyBuf = bodyBuf.replace('<head>', webServiceJsInject.toString())
					res.end(bodyBuf);
				});
			} else {
				// otherwise pass through body unmodified
				response.pipe(res, {end: true});
			}
		}
		return handleReverseProxy(req, hostname, callback);
	}
	if(hostname === 'ipinfo.io'
	|| hostname === 'mii-secure.cdn.nintendo.net'
	|| hostname === 'quic.rocks:4433'
	) {
		return handleReverseProxy(req, hostname, pipeResponseCallback(res));
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
// do nxapi init FIRST!
nxapiInit().then(() => {
	httpolyglot.createServer({
		// self-signed certs representing "*.nintendo.net"
		key: fs.readFileSync('nintendo-net.key'),
		cert: fs.readFileSync('nintendo-net.pem'),
		// without this the server will not serve http2
		ALPNProtocols: ['h2', 'http/1.1']
	}, requestHandler)//errorHandlerWrapper(requestHandler))
	.listen(8443/*, '127.0.0.1', () => {
		console.log('listening');
	}*/);
});

