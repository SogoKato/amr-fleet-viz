/**
 * Capture docs/screenshot.png from the built app, headlessly.
 *
 * Usage: npm run screenshot [-- <seconds> <output.png>]
 *   seconds  simulation time to advance before capturing (default 13)
 *   output   output path (default docs/screenshot.png)
 *
 * Requires `npx playwright install chromium` once.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";

const simSeconds = Number(process.argv[2] ?? 13);
const outPath = process.argv[3] ?? "docs/screenshot.png";

const server = await preview({ preview: { port: 4173, strictPort: false } });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("vite preview did not report a local URL (did the build run?)");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  await page.goto(url);
  // Wait until the default scenario has loaded (its name appears in the header).
  await page.waitForFunction(() => {
    const el = document.getElementById("scenario-name");
    return el !== null && el.textContent !== "";
  });
  // Fast-forward the simulation in real time at 8x, then pause for a stable shot.
  await page.selectOption("#sim-speed", "8");
  await page.waitForFunction(
    (target) => document.getElementById("clock")?.textContent?.match(/t = ([\d.]+)s/)?.[1] !== undefined &&
      Number(document.getElementById("clock")!.textContent!.match(/t = ([\d.]+)s/)![1]) >= target,
    simSeconds,
  );
  await page.click("#play-pause");
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  console.log(`captured ${outPath} at ${await page.textContent("#clock")}`);
} finally {
  await browser.close();
  await server.close();
}
