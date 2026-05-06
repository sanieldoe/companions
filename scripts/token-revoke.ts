import { revokeToken } from "../server/src/auth.js";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const id = getArg("--id");
if (!id) {
  console.error("Usage: npm run token:revoke -- --id <uuid>");
  process.exit(1);
}

const entry = revokeToken(id);
if (!entry) {
  console.error(`Token not found: ${id}`);
  process.exit(1);
}

console.log(`Revoked token ${entry.id} (${entry.label})`);
