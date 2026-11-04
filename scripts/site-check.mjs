import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 相对仓库根目录定位，从任何工作目录执行都可用
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

globalThis.window = {};
const i18nSrc = fs.readFileSync(path.join(root, "assets", "i18n.js"), "utf8");
new Function(i18nSrc).call(globalThis);
const EN = globalThis.window.KEYPER_EN || {};

const keys = new Set();
for (const m of html.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)) keys.add(m[1]);

const missing = [...keys].filter((k) => !(k in EN));
const unused = Object.keys(EN).filter((k) => !keys.has(k) && !k.startsWith("page."));

console.log(`html keys: ${keys.size} · en keys: ${Object.keys(EN).length}`);
console.log(`missing en translations: ${missing.length}${missing.length ? "\n  " + missing.join("\n  ") : ""}`);
console.log(`unused en keys: ${unused.length}${unused.length ? "\n  " + unused.join("\n  ") : ""}`);

const assets = [...html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].map((m) => m[1]);
const shots = [...html.matchAll(/data-full="(assets\/[^"]+)"/g)].map((m) => m[1]);
const bad = [...new Set([...assets, ...shots])].filter((a) => !fs.existsSync(path.join(root, a)));
console.log(`asset refs: ${new Set([...assets, ...shots]).size} · missing files: ${bad.length}${bad.length ? "\n  " + bad.join("\n  ") : ""}`);

const orphanShots = fs
  .readdirSync(path.join(root, "assets", "screenshots"))
  .filter((f) => !html.includes(f));
console.log(`unused screenshots: ${orphanShots.length}${orphanShots.length ? "\n  " + orphanShots.join("\n  ") : ""}`);

const open = (t) => (html.match(new RegExp(`<${t}[\\s>]`, "g")) || []).length;
const close = (t) => (html.match(new RegExp(`</${t}>`, "g")) || []).length;
for (const t of ["section", "div", "article", "figure", "details", "table", "tbody", "tr", "td", "th", "ul", "li", "p", "h2", "h3", "h4"]) {
  const a = open(t), b = close(t);
  if (a !== b) console.log(`TAG MISMATCH <${t}>: ${a} open / ${b} close`);
}

// 站点只以 Keyper 呈现，历史项目名不得出现在页面或英文词条里。
// 这里拆开书写，避免这些名字本身留在仓库文件中。
const banned = ["Redis" + "Doc" + "ter", "Redis" + "Desk" + "top", "redis" + "-doc" + "ter"];
const hits = banned.filter((w) => html.includes(w) || JSON.stringify(EN).includes(w));
console.log(`legacy project names present: ${hits.length ? hits.join(", ") : "none"}`);
