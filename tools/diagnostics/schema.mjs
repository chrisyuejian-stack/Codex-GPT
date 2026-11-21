import { fixture } from "../../tests/support.mjs";
const f = await fixture({ legacyUrls: false });
const rows = f.db.raw.prepare("select type,name,tbl_name from sqlite_master where name not like 'sqlite_%' order by type,name").all();
console.log(JSON.stringify(rows.map(r=>r.type+":"+r.name)));
