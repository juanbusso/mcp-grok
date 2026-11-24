import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GROK_CLI_BIN as grokBin, GROK_CLI_AUTH as authFile, notify } from "./config.mjs";

const outInfo = process.env.GROK_DEVICE_CODE_FILE || path.join(os.tmpdir(), "grok-device-code.json");

try { fs.unlinkSync(outInfo); } catch (err) { if (err.code !== "ENOENT") throw err; }

const child = spawn(grokBin, ["login", "--device-auth"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOME: os.homedir() }
});

let buf = "";
const onData = (chunk) => {
  const clean = chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  buf += clean;
  const m = buf.match(/https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9-]+)/i);
  if (m && !fs.existsSync(outInfo)) {
    fs.writeFileSync(outInfo, JSON.stringify({ url: m[0], code: m[1], createdAt: new Date().toISOString() }, null, 2));
  }
};

child.stdout.on("data", onData);
child.stderr.on("data", onData);

child.on("close", async (code) => {
  if (fs.existsSync(authFile)) {
    await notify("Grok Build CLI authorized: the OAuth device code was approved and the CLI auth file was created.");
  }
  process.exit(code ?? 0);
});
