import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

import { PROFILE_DIR, CHROME_PATH, GROK_CLI_AUTH as AUTH_PATH, GROK_CLI_BIN } from "./config.mjs";

console.log("Starting grok login --device-auth...");
const proc = spawn(GROK_CLI_BIN, ["login", "--device-auth"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let urlFound = null;

function handleChunk(d) {
  const s = d.toString();
  console.log("[grok-cli]", s.trim());
  const m = s.match(/https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=[A-Z0-9-]+/);
  if (m && !urlFound) {
    urlFound = m[0];
    autoApprove(urlFound).catch((err) => console.error("autoApprove error:", err));
  }
}

proc.stdout.on("data", handleChunk);
proc.stderr.on("data", handleChunk);

async function autoApprove(url) {
  console.log("Opening URL in the saved browser profile:", url);
  for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = path.join(PROFILE_DIR, lockFile);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-position=-2400,-2400",
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);

  for (let step = 1; step <= 3; step++) {
    console.log(`--- Step ${step} ---`);
    console.log("Page URL:", page.url());
    const text = await page.innerText("body").catch(() => "");
    console.log("Page text:", JSON.stringify(text.slice(0, 500)));

    let clicked = false;
    for (const label of [
      "Continuar",
      "Continue",
      "Autorizar",
      "Authorize",
      "Confirmar",
      "Confirm",
      "Permitir",
      "Allow",
      "Approve",
      "Aceptar",
    ]) {
      const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") });
      if ((await btn.count()) > 0) {
        console.log(`Clicking button: ${label}`);
        await btn.first().click();
        clicked = true;
        await page.waitForTimeout(3500);
        break;
      }
    }
    if (!clicked) {
      console.log("No matching action button found on step", step);
      break;
    }
    if (fs.existsSync(AUTH_PATH)) {
      console.log("SUCCESS! auth.json created!");
      break;
    }
  }

  await page.waitForTimeout(2000);
  await ctx.close();
}

proc.on("exit", (code) => {
  console.log("grok login exited with", code, "auth.json exists:", fs.existsSync(AUTH_PATH));
  process.exit(0);
});

setTimeout(() => {
  console.log("Timeout reached, killing proc");
  proc.kill();
  process.exit(0);
}, 25000);
