function FindProxyForURL(url, host) {
  if(localHostOrDomainIs(host, "api-lp1.znc.srv.nintendo.net")
  || localHostOrDomainIs(host, "accounts.nintendo.com")) {
    return "PROXY debian.attlocal.net:36017";
  }
  return "DIRECT";
}
