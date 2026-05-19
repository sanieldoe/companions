import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(serverDir, "..");

const steps = [
  { name: "server", cwd: serverDir, args: ["run", "build"] },
  { name: "web", cwd: path.join(repoRoot, "web"), args: ["run", "build"] },
  { name: "app", cwd: path.join(repoRoot, "app"), args: ["run", "build"] },
];

for (const step of steps) {
  console.log(`[setup] Building ${step.name}...`);
  const result = spawnSync("npm", step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("[setup] Build assets ready. Start the server and open /install.");
