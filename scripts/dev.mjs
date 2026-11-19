// Local, in-memory preview. No production data, secrets, or automatic login injection.
import http from "node:http";
import { fixture } from "../tests/support.mjs";
const f = await fixture({ legacyUrls: false });
f.env.APP_HOST = "localhost";
const response = await f.directRequest("http://localhost/api/setup", {
  method: "POST",
  headers: {
    Origin: "http://localhost",
    "Content-Type": "application/json",
    "X-Setup-Key": f.env.SETUP_KEY,
  },
  body: JSON.stringify({
    name: "预览主管",
    phone: "13911112222",
    password: "PreviewSecure9Z",
  }),
});
if (response.status !== 201) throw Error(await response.text());
const port = Number(process.env.PREVIEW_PORT || 4173);
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await f.directRequest(
      "http://localhost:" + port + req.url,
      {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : Buffer.concat(chunks),
      },
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("preview error");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `本机内存预览：http://localhost:${port}/login\n测试主管：13911112222 / PreviewSecure9Z（不进入生产包）`,
  ),
);
process.on("SIGINT", () => {
  server.close();
  f.restore();
  process.exit();
});
