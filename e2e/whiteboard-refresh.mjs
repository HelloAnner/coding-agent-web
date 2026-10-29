import { chromium } from "playwright";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const board = "data/notes/1/刷新冒烟.excalidraw";
const empty = JSON.stringify({ type: "excalidraw", version: 2, source: "smoke", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2);
writeFileSync(board, empty);
const env = readFileSync(".env.local", "utf8");
const password = /^PI_WEB_PASSWORD=(.*)$/m.exec(env)[1].trim().replace(/^["']|["']$/g, "");
const agentScene = readFileSync("data/notes/并发/Disruptor.excalidraw", "utf8");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ httpCredentials: { username: "pi", password }, viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 120)); });
  await page.goto("http://127.0.0.1:20169/login", { waitUntil: "domcontentloaded" });
  await page.fill("input[type=password]", password);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle").catch(() => {});
  const url = `http://127.0.0.1:20169/notes?path=${encodeURIComponent("1/刷新冒烟.excalidraw")}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas.static", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const count = () => page.evaluate(() => {
    const c = document.querySelector("canvas.static");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) n++;
    return n;
  });
  console.log("打开空板 ink:", await count());
  writeFileSync(board, agentScene);
  console.log("已从外部写入 42 元素");
  await page.waitForTimeout(4000);
  console.log("4 秒后 ink:", await count());
  const after = JSON.parse(readFileSync(board, "utf8"));
  console.log("磁盘上现在:", after.elements.length, "元素, source:", after.source);
  console.log("errors:", errors.slice(0, 4));
} finally {
  await browser.close();
  rmSync(board, { force: true });
}
