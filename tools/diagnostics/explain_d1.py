"""Send EXPLAIN <sql> (compile-only, never executes) for every collected statement to production D1."""
import json, re, sys, time, urllib.request, urllib.error

URL = "https://api.cloudflare.com/client/v4/accounts/a9d8fe2813029e34c9a30534a1d05551/d1/database/f4eaf652-ce6d-4098-909b-0f6563dbfd31/query"
src = json.load(open(sys.argv[1], encoding="utf8"))
out = sys.argv[2]


def strip_strings(sql):
    """Return sql with single-quoted literals blanked, so ; and ? inside strings are ignored."""
    res, q, i = [], False, 0
    while i < len(sql):
        c = sql[i]
        if c == "'":
            if q and i + 1 < len(sql) and sql[i + 1] == "'":
                i += 2
                continue
            q = not q
            res.append(" ")
        else:
            res.append(" " if q else c)
        i += 1
    return "".join(res)


def placeholders(sql):
    s = strip_strings(sql)
    numbered = [int(x) for x in re.findall(r"\?(\d+)", s)]
    bare = len(re.findall(r"\?(?!\d)", s))
    return max(max(numbered) if numbered else 0, bare)


results = {"ok": 0, "error": [], "skipped": []}
last = 0.0
for sql, recorded in src.items():
    head = sql.split(" ")[0].upper()
    if head in ("PRAGMA", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK"):
        results["skipped"].append([sql[:160], "DDL/PRAGMA/事务语句，未发送"])
        continue
    body = sql.strip().rstrip(";").strip()
    if ";" in strip_strings(body):
        results["skipped"].append([sql[:160], "包含多条语句，未发送"])
        continue
    stmt = "EXPLAIN " + body
    # Hard safety assertions before anything leaves this machine.
    assert stmt.startswith("EXPLAIN ")
    assert ";" not in strip_strings(stmt)
    n = max(recorded, placeholders(body))
    payload = json.dumps({"sql": stmt, "params": [None] * n}).encode()
    for attempt in range(6):
        wait = 0.21 - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        last = time.time()
        req = urllib.request.Request(URL, data=payload, headers={"Authorization": "Bearer proxy-injected", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            status = 200
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                d = json.load(e)
            except Exception:
                d = {"errors": [{"message": "HTTP %d" % e.code}]}
        if status == 429:
            time.sleep(2 ** attempt)
            continue
        break
    if d.get("success"):
        results["ok"] += 1
    else:
        msg = "; ".join(x.get("message", "") for x in d.get("errors", []))
        results["error"].append({"sql": sql, "params": n, "error": msg})
json.dump(results, open(out, "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("ok", results["ok"], "error", len(results["error"]), "skipped", len(results["skipped"]))
