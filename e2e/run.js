const { chromium } = require("playwright");
const path = require("path").resolve(__dirname, "..");
const results = [];
const ok = (name, cond, extra="") => { results.push([cond, name, extra]); console.log((cond?"PASS":"FAIL")+" "+name+(extra?" — "+extra:"")); };

(async () => {
  const ctx = await chromium.launchPersistentContext(require("path").join(require("os").tmpdir(), "gramr-e2e-profile"), {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  ok("extension loaded", !!extId, extId);

  // ── content script on an http page ──
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("page: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") { if (!m.text().includes("favicon") && !m.text().includes("404")) errors.push("console: " + m.text()); }; });
  await page.goto("http://localhost:8901/page.html");
  await page.click("#ta");
  await page.waitForSelector("[data-gramr-container]", { timeout: 5000 }).catch(() => {});
  let container = await page.$("[data-gramr-container]");
  ok("textarea underlines render", !!container);
  const targets = await page.$$("[data-gramr-container] div");
  ok("click targets exist", targets.length >= 3, targets.length + " targets");
  const svgPaths = await page.$$eval("svg path", (ps) => ps.length).catch(() => 0);
  ok("svg underline paths drawn", svgPaths >= 3, svgPaths + " paths");

  // tooltip opens on click
  await targets[0].click();
  const tip = await page.waitForSelector(".gramr-tooltip", { timeout: 3000 }).catch(() => null);
  ok("tooltip opens", !!tip);
  if (tip) {
    const label = await tip.$eval(".gramr-tip-label", (el) => el.textContent).catch(() => "");
    ok("tooltip has label", !!label, label);
    const nav = await tip.$(".gramr-nav-count");
    ok("nav counter shown", !!nav, nav ? await nav.textContent() : "");
    // apply correction
    const apply = await tip.$("[data-apply]");
    ok("apply button present", !!apply);
    if (apply) {
      const before = await page.$eval("#ta", (el) => el.value);
      await apply.click();
      await page.waitForTimeout(700);
      const after = await page.$eval("#ta", (el) => el.value);
      ok("correction applied", after !== before, JSON.stringify(after.slice(0, 40)));
      // undo works
      await page.click("#ta");
      await page.keyboard.press("Control+z");
      const undone = await page.$eval("#ta", (el) => el.value);
      ok("Ctrl+Z restores text", undone === before, JSON.stringify(undone.slice(0, 24)));
    }
  }
  // Escape closes tooltip
  await page.waitForTimeout(900);
  const t2 = await page.$$("[data-gramr-container] div");
  if (t2.length) { await t2[0].click(); await page.waitForSelector(".gramr-tooltip"); }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  ok("Escape closes tooltip", !(await page.$(".gramr-tooltip")));

  // ── contenteditable underlines ──
  await page.click("#ce");
  await page.waitForTimeout(1200);
  const ceBadge = await page.$(".gramr-badge");
  const cePaths = await page.$$eval("svg path", (ps) => ps.length).catch(() => 0);
  ok("contenteditable underlines (not badge)", !ceBadge && cePaths > 0, cePaths + " paths");

  ok("no page errors on content page", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ── popup renders ──
  const popup = await ctx.newPage();
  const perrs = [];
  popup.on("pageerror", (e) => perrs.push(e.message));
  popup.on("console", (m) => { if (m.type() === "error") perrs.push(m.text()); });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(600);
  const ruleCount = await popup.$$eval("#ruleList li", (l) => l.length);
  ok("popup rule list renders", ruleCount > 30, ruleCount + " rules");
  const lvl = await popup.$eval("#levelTitle", (el) => el.textContent);
  ok("popup level shows", /Lv \d/.test(lvl), lvl);
  const optRows = await popup.$$eval(".opt-row input", (l) => l.length);
  ok("options toggles present", optRows === 7, optRows + " toggles");
  ok("no popup errors", perrs.length === 0, perrs.slice(0, 3).join(" | "));

  // ── welcome page playground ──
  const wel = await ctx.newPage();
  const werrs = [];
  wel.on("pageerror", (e) => werrs.push(e.message));
  wel.on("console", (m) => { if (m.type() === "error") werrs.push(m.text()); });
  await wel.goto(`chrome-extension://${extId}/welcome.html`);
  await wel.click("#play");
  await wel.waitForSelector("[data-gramr-container]", { timeout: 5000 }).catch(() => {});
  const wcont = await wel.$("[data-gramr-container]");
  const wpaths = await wel.$$eval("svg path", (ps) => ps.length).catch(() => 0);
  ok("welcome playground underlines", !!wcont && wpaths >= 5, wpaths + " paths");
  ok("no welcome page errors", werrs.length === 0, werrs.slice(0, 3).join(" | "));

  await ctx.close();
  const fails = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
