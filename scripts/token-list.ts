import { readTokenStore } from "../server/src/auth.js";

const store = readTokenStore();

if (store.tokens.length === 0) {
  console.log("No tokens found.");
  process.exit(0);
}

console.log(["ID", "LABEL", "CREATED", "LAST SEEN", "REVOKED"].join("\t"));
for (const token of store.tokens) {
  console.log([
    token.id,
    token.label,
    token.createdAt,
    token.lastSeenAt ?? "-",
    token.revokedAt ?? "-",
  ].join("\t"));
}
