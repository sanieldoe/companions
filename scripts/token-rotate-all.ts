import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rotateAllTokens } from "../server/src/auth.js";
import { getConfig } from "../server/src/config.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(PROJECT_ROOT, "server", ".env");

const next = rotateAllTokens("setup-initial");
const config = getConfig();
const url = `http://${config.publicHost}:${config.port}`;

let env = "";
try {
  env = fs.readFileSync(ENV_PATH, "utf8");
} catch {
  env = "";
}

if (env.includes("ACCESS_TOKEN=")) {
  env = env.replace(/^ACCESS_TOKEN=.*$/m, `ACCESS_TOKEN=${next.token}`);
} else {
  env = `${env.trim()}\nACCESS_TOKEN=${next.token}\n`;
}
fs.writeFileSync(ENV_PATH, env.trim() + "\n", "utf8");

console.log(`Rotated all tokens. New token id: ${next.id}`);
console.log(`Token: ${next.token}`);
console.log(`URL:   ${url}`);
console.log(`Pair payload: companions://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(next.token)}`);
