import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Exercise the real migration block with a shell-function CLI stub. No secrets,
// database, container filesystem, or actual migration commands are touched.
const source = readFileSync(resolve(__dirname, "../../../docker-entrypoint.sh"), "utf8");
const migrationBlock = source.slice(source.indexOf('if [ "${RUN_MIGRATIONS:-true}"'), source.indexOf('exec "$@"'));
function run(output: string, exitCode: number) {
  return spawnSync("sh", ["-c", `set -e
    DATABASE_URL=isolated-test
    PRISMA_AUTO_RESOLVE=false
    npx() { printf '%s\\n' "$STUB_OUTPUT"; return "$STUB_EXIT"; }
    ${migrationBlock}
    echo SERVER_START
  `], { encoding: "utf8", env: { ...process.env, STUB_OUTPUT: output, STUB_EXIT: String(exitCode) } });
}
describe("container migration startup", () => {
  it("starts the server after successful migration", () => {
    const result = run("No pending migrations", 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SERVER_START");
  });
  it.each(["P3009 failed migration", "Database unavailable"])("fails closed with actionable diagnostics: %s", message => {
    const result = run(message, 1);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(message);
    expect(result.stdout).toContain("FATAL: prisma migrate deploy failed");
    expect(result.stdout).not.toContain("SERVER_START");
  });
});
