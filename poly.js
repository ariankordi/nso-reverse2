const httpolyglot = require('./httpolyglot-patched-index.js');// monkey patched version
//require('@httptoolkit/httpolyglot');
// open certs and js inject file
const { readFileSync } = require('fs');
// cache directory
const { tmpdir } = require('os');

// paths are joined during nxapi imports
const { join } = require('path');

// ad-hoc functions that help out with reverse proxying
const {
	filterHeaders,
	wrapCompressedResponse,
	handleReverseProxy,
	pipeResponseCallback,
	logAccess,
} = require('./reverse-proxy-helpers.js');

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
let paths, getToken, initStorage;
let /*webServices, */webServiceMap;
// NOTE: should token be included?
let storage, usernsid, naToken;
// compared against what mitm'ed GetToken is requesting
let nsoUserID;
async function nxapiInit() {
	// required to make http_proxy work here
	//const { setGlobalDispatcher } = require('undici');
	console.log('initializing nxapi (may fail right now)...');
	const nxapiExport = require.resolve('nxapi');
	// import() wrapper for paths within nxapi dist..!! (join = path.join btw)
	const nxapiInternal = m => import(join(nxapiExport, '../../' + m));
    await Promise.all([
		// handle setting http proxy (newer versions of nxapi)
		/*nxapiInternal('util/undici-proxy.js').then(m => {
			// NOTE: proxy code NOT added to upstream reverse proxy yet
			// effectively, only nxapi would be proxied with this.
			const agent = m.buildEnvironmentProxyAgent();
			setGlobalDispatcher(agent);
			// handle if it fails because nxapi 1.6.1 does not have this
		}).catch(err => {
			console.error('could not load undici-proxy.js, nxapi will not pass through HTTP_PROXY:\n', err);
		}),*/
		// decided that proxy may not be fully necessary bc proxychains works
        nxapiInternal('util/useragent.js').then(m => {
			// add user agent, pretending to be nxapi-cli
			m.addUserAgent('nxapi-cli');
			if(process.env.NXAPI_USER_AGENT) {
				// TODO: perhaps add my own user-agent, or remove this, or both
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
		console.log('nxapi loaded! now authenticating...');
		// some of these are now persisted throughout functions
		// TODO: lock storage behind a mutex?
		storage = await initStorage(paths.data);
		usernsid = await storage.getItem('SelectedUser');
		// if SelectedUser is undefined then persist is most likely unpopulated
		if(usernsid === undefined) {
			// nxapi is not authenticated/set up!! instruct user to run nso auth
			console.log('\x1b[31mno selected user: \x1b[1mnxapi is not authenticated!\x1b[0m try running this:')
			const cliEntry = join(nxapiExport, '../../cli-entry.js');
			console.log(`\x1b[2m${cliEntry} nso auth\x1b[0m\nyou should also be able to log into the nxapi desktop app? try that and come back.\nexiting`)
			process.exit(1)
		}
		console.log(`nxapi selected usernsid: \x1b[1m${usernsid}\x1b[0m`);
		// the nintendo account token does not often change..!
		naToken = await storage.getItem('NintendoAccountToken.' + usernsid);
		// the nso token, on the other hand, does.
		const { nso, data } = await getToken(storage, naToken);
		// nso user id is not the same as nintendo account id
		nsoUserID = data['nsoAccount']['user']['id'];
		console.log(`logged in to nxapi as \x1b[1m${data.user.nickname}\x1b[0m (nso user id: \x1b[1m${nsoUserID}\x1b[0m)`);
		console.log(`\x1b[2mtodo: add directions to log into nxapi in general but also change current user or specify it as cli argument\x1b[0m`)
		// get language so we can find a cached version
		// NOTE: sadly this means that it's "mandatory" to use getToken
		// TODO: cache language in persistent-cache...
		const language = data.user.language;
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
		console.log(`\x1b[32msuccessfully fetched ${webServices.length} web services from ${webServicesCached ? 'cache' : 'getWebServices()'}\x1b[0m`);
		// make a map of webservices where...
		// key is hostname and value is the ID
		webServiceMap = webServices.reduce((obj, service) => {
			const hostname = new URL(service.uri).hostname;
			//obj[hostname] = service.id;
			obj.set(hostname, service.id);
			return obj;
		}, new Map());
	});
}

// function that abstracts setting a cached webservicetoken...
async function setCachedWebServiceToken(webserviceID, token, yourUserNSID=undefined) {
	// TODO MAKE THIS MORE EFFICIENT
	let localUserNSID = usernsid || yourUserNSID;
	/*if(usernsid === undefined) {
		const storage = await initStorage(paths.data);
		usernsid = await storage.getItem('SelectedUser');
	}*/

	// expiresIn is merely a unit of time of how long the token lasts
	// add tokenExpiry to the webServiceToken object...!!
	token.tokenExpiry = Date.now() + (token.expiresIn * 1000);
	// store cache async, no-op when done
	const cacheKey = `WebServiceToken.${localUserNSID}.${webserviceID}`;
	cache.put(cacheKey, token, () => {});
}

async function getWebServiceToken(webserviceID) {
	console.log('grabbing a webservicetoken for id: ' + webserviceID)
	// redo getting storage and user all over again
	// ... but this stuff SHOULD be cached.
	/*const storage = await initStorage(paths.data);
	const usernsid = await storage.getItem('SelectedUser');
	const naToken = await storage.getItem('NintendoAccountToken.' + usernsid);
	*/const { nso } = await getToken(storage, naToken);
	// get servicetoken from cache or not!!!!
	const cacheKey = `WebServiceToken.${usernsid}.${webserviceID}`;
	const cacheResult = cache.getSync(cacheKey);
	if(cacheResult && cacheResult.tokenExpiry > Date.now()) {
		console.log(`fetched token for ${webserviceID} from \x1b[32mcache\x1b[0m`);
		return cacheResult.accessToken;
	}
	//if(cacheResult.tokenExpiry < Date.now()) { console.log('cache expired...') }
	let webServiceToken = await nso.getWebServiceToken(webserviceID);
	setCachedWebServiceToken(webserviceID, webServiceToken, usernsid);
	console.log(`fetched token for ${webserviceID} from \x1b[31mgetWebServiceToken()\x1b[0m`);
	return webServiceToken.accessToken;
}


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
			console.log('set webservicetoken cache...');
		} else {
			console.log('GetWebServiceToken response does not have result...');
		}
	},
	'/Account/GetToken': async (data, {}, req) => {
		//console.log('\x1b[1mMMM MMM MMMM COME GET YOUR \x1b[0mnso account token\x1b[1m RIGHT HERE!!!!!!!!!!\x1b[0m:\n', data)
		if(data.result === undefined) {
			console.log('GetToken response does not have result...');
			return;
		}
		//await storage.getItem('NsoToken.' + naToken);
		// first pre-process and warn if nso user id differs from nxapi one
		const thisNSOUserID = data['result']['user']['id'];
		if(thisNSOUserID !== nsoUserID) {
			console.log(`\x1b[31mnso user id received from intercepted GetToken request (${thisNSOUserID}) does not match global one ${nsoUserID}...!!!!\x1b[0m`);
			console.log('is the mobile app logged into the same user as nxapi?');
		}
		// grab cached NsoToken and inject our own details in
		// mostly because it has information like... f data,
		// ... znca version, and most notably PROFILE that are unavailable
		const cacheKey = 'NsoToken.' + naToken;
		const nsoTokenData = await storage.getItem(cacheKey);
		// append our own data from here
		nsoTokenData['nsoAccount'] = data.result;
		nsoTokenData['credential'] = data.result.webApiServerCredential;
		// TODO: CACHE NINTENDO ACCOUNT RESPONSE
		// AND THEN COPY OVER ITS ACCESS_TOKEN FROM HERE TOO!!!
		nsoTokenData['nintendoAccountToken']['id_token'] = req.headers['authorization'].split('Bearer ')[1]
		// write back data...
		storage.setItem(cacheKey, nsoTokenData);
		console.log('set nso token cache...');
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
				bodyObj = JSON.parse(bodyBuf);
			} catch(e) {
				console.error('FAILURE WHEN DECODING JSON RESPONSE IN CORAL API INTERCEPTION:', e)
				return;
			}

			// TODO error check all of this
			const reqBodyStr = reqBody.toString();
			let reqBodyObj;
			if(reqBodyStr.length) {
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

async function requestHandler(req, res) {
	logAccess(req);
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
	if(hostname === 'api-lp1.znc.srv.nintendo.net') {
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
		// TODO you may want to always inject something like this: ?lang=en-US&na_country=US&na_lang=en-US
		if(req.url === '/' || req.url.startsWith('/?')) {
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
	if(hostname === 'ipinfo.io'
	|| hostname === 'mii-secure.cdn.nintendo.net'
	|| hostname === 'quic.rocks:4433'
	|| hostname === 'accounts.nintendo.com'
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
	// TODO THIS LIB IS MONKEY PATCHED, LOOK INTO A BETTER WAY TO DO IT!!!!!!
	// TODO FIGURE OUT BETTER MONKEY PATCHES FOR THIS
	const server = httpolyglot.createServer({
		// self-signed certs representing "*.nintendo.net"
		key: readFileSync(__dirname + '/nintendo-net.key'),
		cert: readFileSync(__dirname + '/nintendo-net.pem'),
		// without this the server will not serve http2
		ALPNProtocols: ['h2', 'http/1.1']
	}, requestHandler);//errorHandlerWrapper(requestHandler))
	if(process.env.LISTEN_FDS) {
		// handle systemd socket (VERY USE CASE SPECIFIC)
		const { getListenArgs } = require('@derhuerst/systemd');
		// TODO THIS IS UNTESTED!!
		return server.listen(...getListenArgs(), () => {
			console.log('server listening on systemd socket!!');
		});
	}
	// TODO make this host:port customizable
	server.listen(8443, () => {
		console.log('now listening on port 8443');
	});
});

