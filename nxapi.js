// paths are joined during nxapi imports
const { join } = require('path');

let paths, getToken, initStorage;
//let /*webServices, */webServiceMap;
// NOTE: should token be included?
let storage, usernsid, naToken;
// compared against what mitm'ed GetToken is requesting
let nsoUserID;

// NOTE: imported from main poly.js
let cache;
async function nxapiInit(mainCache) {
	cache = mainCache;
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
	])
	// THEN fetch web services, this is where errors will happen
	console.log('nxapi loaded! now authenticating...');
	// some of these are now persisted throughout functions
	// TODO: lock storage behind a mutex?
	storage = await initStorage(paths.data);
	// TODO: here, select usernsid from CLI
	usernsid = await storage.getItem('SelectedUser');
	// if SelectedUser is undefined then persist is most likely unpopulated
	// process exits here because we are not going anywhere.
	if(usernsid === undefined) {
		// nxapi is not authenticated/set up!! instruct user to run nso auth
		console.log('\x1b[31mno selected user: \x1b[1mnxapi is not authenticated!\x1b[0m try running this:')
		const cliEntry = join(nxapiExport, '../../cli-entry.js');
		console.log(`\x1b[2m${cliEntry} nso auth\x1b[0m\nyou should also be able to log into the nxapi desktop app? try that and come back.\nexiting`)
		process.exit(1);
	}
	console.log(`nxapi selected usernsid: \x1b[1m${usernsid}\x1b[0m`);
	// the nintendo account token does not often change... nso token DOES
	naToken = await storage.getItem('NintendoAccountToken.' + usernsid);
	const { nso, data } = await getToken(storage, naToken);
	// nso user id is not the same as nintendo account id
	nsoUserID = data['nsoAccount']['user']['id'];
	console.log(`logged in to nxapi as \x1b[1m${data.user.nickname}\x1b[0m (nso user id: \x1b[1m${nsoUserID}\x1b[0m)`);
	console.log(`\x1b[2mtodo: add directions to log into nxapi in general but also change current user or specify it as cli argument\x1b[0m`)
	// get language so we can find a cached version
	// NOTE: sadly this means that it's "mandatory" to use getToken
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
			language,
			user: data.user.id,
		});
		// set language in persistent-cache
		// NOTE: this means language may persist even if you don't want it to
		//cache.put('language', data.user.language, () => {});
		// not done because there is a case where language is cached but CachedWebServicesList is not.
	}
	console.log(`successfully fetched ${webServices.length} web services from ${webServicesCached ? '\x1b[32mcache' : '\x1b[31mgetWebServices()'}\x1b[0m`);
	// make a map of webservices where...
	// key is hostname and value is the ID
	// turned into webServiceMap in main
	const webServiceMap = webServices.reduce((obj, service) => {
		const hostname = new URL(service.uri).hostname;
		//obj[hostname] = service.id;
		obj.set(hostname, service.id);
		return obj;
	}, new Map());
	// to be put into web service url so that it loads properly
	const naURLParts = `&na_country=${data.user.country}&na_lang=${data.user.language}`;
	return { webServiceMap, naURLParts };
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
	*/
	// get servicetoken from cache or not!!!!
	const cacheKey = `WebServiceToken.${usernsid}.${webserviceID}`;
	const cacheResult = cache.getSync(cacheKey);
	if(cacheResult) {
		const expiryDelta = cacheResult.tokenExpiry - Date.now();
		// if expiry was reached then this will probably be negative
		if(expiryDelta > 0) {
			console.log(`fetched token for ${webserviceID} from \x1b[32mcache\x1b[0m`);
			return cacheResult.accessToken;
		} else {
			// failed case: there is a cache but it expired (want to log this)
			// expiryDelta should be in milliseconds..?
			console.log(`\x1b[31mcached webservicetoken expired ${expiryDelta / 1000} seconds ago...\x1b[0m`);
		}
	}
	//if(cacheResult.tokenExpiry < Date.now()) { console.log('cache expired...') }
	const { nso } = await getToken(storage, naToken);
	let webServiceToken = await nso.getWebServiceToken(webserviceID);
	setCachedWebServiceToken(webserviceID, webServiceToken, usernsid);
	console.log(`fetched token for ${webserviceID} from \x1b[31mgetWebServiceToken()\x1b[0m`);
	// log if there is no cached webservicetoken as opposed to it having expired
	if(!cacheResult) {
		console.log(`\x1b[31m(there is no cached webservicetoken)\x1b[0m`)
	}
	return webServiceToken.accessToken;
}

// might not belong here but it does use these variables over here
async function getTokenInterceptHandler(data, reqBodyObj, req) {
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
	// see if there is a latest na token response that we have cached
	// double check that it matches authorization header...
	// this SHOULDN'T error out since authorization should always be set
	// TODO DOUBLE CHECK THIS.  there seems to still be discrepancies between the header(???????) for GetToken and na token (s????)
	//const authorizationHeaderAfterBearer = req.headers['authorization'].split('Bearer ')[1];
	const naIdToken = reqBodyObj['parameter']['naIdToken']
	const latestNATokenResponse = cache.getSync('latest-na-token-response');
	if(latestNATokenResponse !== undefined
	&& naIdToken === latestNATokenResponse.id_token
	) {
		/// and set it accordingly
		console.log('setting nso token cache with na token response...');
		nsoTokenData['nintendoAccountToken'] = latestNATokenResponse;
	} else {
		// otherwise do this hacky splitting gag
		// from request headers that only sets id_token!!!!
		console.log('there was either no na token response ('+ String(latestNATokenResponse === undefined) +') or the naIdToken did not match id_token so it will not be used for nso token cache')
		nsoTokenData['nintendoAccountToken']['id_token'] = naIdToken
	}
	// write back data...
	storage.setItem(cacheKey, nsoTokenData);
	console.log('set nso token cache...');
}

module.exports = {
	nxapiInit,
	setCachedWebServiceToken,
	getWebServiceToken,
	// handlers?
	getTokenInterceptHandler,
};
