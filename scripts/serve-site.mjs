import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 相对仓库根目录定位，从任何工作目录执行都可用
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const port = Number(process.argv[2] || 4321);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(root, url === "/" ? "index.html" : url);
  if (!file.startsWith(root)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(port, "127.0.0.1", () => console.log(`keyper site → http://127.0.0.1:${port}/`));
