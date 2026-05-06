import { issueToken } from "../server/src/auth.js";
import { getConfig } from "../server/src/config.js";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const label = getArg("--label") ?? "manual";
const entry = issueToken(label);
const config = getConfig();
const url = `http://${config.publicHost}:${config.port}`;

console.log(`Issued token: ${entry.id}`);
console.log(`Label:        ${entry.label}`);
console.log(`Token:        ${entry.token}`);
console.log(`URL:          ${url}`);
console.log(`Pair payload: companions://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(entry.token)}`);
