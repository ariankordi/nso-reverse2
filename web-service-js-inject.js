<head><script>
// handles nso app-specific functions
// really these should all be handled server-side
// persistentstorage should use the server, and
// requestgamewebtoken especially should
// but these will work for now, along with
// manually assigning a gamewebtoken

/*// if the current params aren't what they are above, add them and refresh
if(window.document.location.search !== queryParamsShouldBe) {
	window.document.location.search = queryParamsShouldBe;
}*/

// ditched for storing in a cookie
/*
const persistentDataRepresentation = {
	// skips walkthrough
	marked: true,

	// my userid. todo remove this if i release this or something i do'nt know
	userId: '0x'

	// persistent data will also contain language-country
	// code as in the lang query parameter but it's only
	// stored when the language is changed, example:
	//language: 'en-GB'
};
*/

//document.cookie = '_gtoken=' + gtoken;

// game token (x-gamewebtoken) request
window.requestGameWebToken = () => {
	window.console.log('requestgametoken called');
	/*setTimeout(() => {
		window.onGameWebTokenReceive(gtoken);
	}, 10);*/
	fetch('/_/request_gamewebtoken')
	.then(response => {
		return response.text();
	})
	.then(data => {
		// data is now gtoken
		window.onGameWebTokenReceive(data);
	});
};
// persistent data request
window.restorePersistentData = () => {
	window.console.log('restorepersistentdata called');
	/*// respond with persistentData
	window.onPersistentDataRestore(JSON.stringify(persistentData));
	*/
	// get persistentdata from cookie (stolen from https://stackoverflow.com/a/15724300)
	let cookieParts = ('; ' + document.cookie).split('; nso-persistent-storage=');

	// "initialize" restoredpersistentdata by making it blank
	// in case we can't find one with the steps below
	var restoredPersistentData = '';

	// this is stupid and might not be stable
	if(cookieParts.length === 2) {
		restoredPersistentData = cookieParts.pop().split(';').shift();
	}

	// respond with restored persistent data
	window.onPersistentDataRestore(restoredPersistentData);
};
window.storePersistentData = (input) => {
	window.console.log('persistentdatastore called', input);

	// store input in cookie "nso-persistent-storage"
	// to expire in three days
	// get a date (stolen from https://stackoverflow.com/a/23081260)
	let expiryDate = new Date();
	expiryDate.setDate(new Date().getDate() + 3);

	// input is a string (json)
	// set cookie
	document.cookie = 'nso-persistent-storage=' + input + '; expires=' + expiryDate.toUTCString() + '; path=/';

	window.onPersistentDataStore();
};
</script>
