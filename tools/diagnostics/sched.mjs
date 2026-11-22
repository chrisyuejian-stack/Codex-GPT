import { fixture } from "../../tests/support.mjs";
const backup = (await import(process.env.BW || "../../src/server/backup.js")).default;
const f = await fixture({ legacyUrls: false });
f.env.APP_HOST="localhost";
const r = await f.directRequest("http://localhost/api/setup",{method:"POST",headers:{Origin:"http://localhost","Content-Type":"application/json","X-Setup-Key":f.env.SETUP_KEY},body:JSON.stringify({name:"主管",phone:"13911112222",password:"PreviewSecure9Z"})});
console.log("setup",r.status);
for (const cron of ["*/5 * * * *","0 19 * * *","*/5 * * * *"]) {
  try { await backup.scheduled({cron,scheduledTime:Date.now()}, f.env, {waitUntil(){}}); console.log(cron,"ok"); }
  catch(e){ console.log(cron,"ERR",e.stack.split("\n").slice(0,4).join(" | ")); }
}
