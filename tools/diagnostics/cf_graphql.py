import json,sys,urllib.request
q=sys.argv[1]
req=urllib.request.Request("https://api.cloudflare.com/client/v4/graphql",data=json.dumps({"query":q}).encode(),headers={"Authorization":"Bearer proxy-injected","Content-Type":"application/json"})
print(json.dumps(json.load(urllib.request.urlopen(req)),ensure_ascii=False))
