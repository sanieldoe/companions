import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  expandPath,
  isSingleGrapheme,
  isPortFree,
  validateEmoji,
  validatePersonaName,
  validatePort,
  validateUrl,
  validateWritableVaultPath,
} from "./validators.js";

describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    assert.equal(expandPath("~"), os.homedir());
  });

  it("expands ~/foo to home/foo", () => {
    assert.equal(expandPath("~/foo"), path.join(os.homedir(), "foo"));
  });

  it("resolves relative paths to absolute", () => {
    const result = expandPath("relative/path");
    assert.ok(path.isAbsolute(result));
  });

  it("leaves absolute paths unchanged", () => {
    assert.equal(expandPath("/tmp/companions"), "/tmp/companions");
  });
});

describe("isSingleGrapheme", () => {
  it("returns true for a single emoji", () => {
    assert.ok(isSingleGrapheme("🐸"));
  });

  it("returns true for a single letter", () => {
    assert.ok(isSingleGrapheme("A"));
  });

  it("returns false for empty string", () => {
    assert.ok(!isSingleGrapheme(""));
  });

  it("returns false for whitespace only", () => {
    assert.ok(!isSingleGrapheme("   "));
  });

  it("returns false for two emojis", () => {
    assert.ok(!isSingleGrapheme("🐸🦊"));
  });

  it("returns false for two letters", () => {
    assert.ok(!isSingleGrapheme("AB"));
  });

  it("returns true for a ZWJ sequence (family emoji)", () => {
    // 👨‍👩‍👧 is a single grapheme cluster via ZWJ
    assert.ok(isSingleGrapheme("👨‍👩‍👧"));
  });
});

describe("validatePersonaName", () => {
  it("accepts a simple name", () => {
    assert.equal(validatePersonaName("Mentor"), undefined);
  });

  it("accepts names with spaces, hyphens, underscores", () => {
    assert.equal(validatePersonaName("My Helper-Bot_1"), undefined);
  });

  it("rejects empty string", () => {
    assert.ok(validatePersonaName("") !== undefined);
  });

  it("rejects whitespace only", () => {
    assert.ok(validatePersonaName("   ") !== undefined);
  });

  it("rejects names longer than 32 chars", () => {
    assert.ok(validatePersonaName("a".repeat(33)) !== undefined);
  });

  it("accepts names exactly 32 chars", () => {
    assert.equal(validatePersonaName("a".repeat(32)), undefined);
  });

  it("rejects names containing slashes", () => {
    assert.ok(validatePersonaName("My/Agent") !== undefined);
  });

  it("rejects names with special chars like @", () => {
    assert.ok(validatePersonaName("Agent@Home") !== undefined);
  });
});

describe("validateEmoji", () => {
  it("accepts a single emoji", () => {
    assert.equal(validateEmoji("🐸"), undefined);
  });

  it("accepts a single letter as a grapheme", () => {
    assert.equal(validateEmoji("A"), undefined);
  });

  it("rejects empty string", () => {
    assert.ok(validateEmoji("") !== undefined);
  });

  it("rejects two emojis", () => {
    assert.ok(validateEmoji("🐸🦊") !== undefined);
  });

  it("rejects whitespace only", () => {
    assert.ok(validateEmoji("  ") !== undefined);
  });
});

describe("validateUrl", () => {
  it("accepts http URLs", () => {
    assert.equal(validateUrl("http://localhost:3000"), undefined);
  });

  it("accepts https URLs", () => {
    assert.equal(validateUrl("https://my-mac.tailnet.ts.net"), undefined);
  });

  it("rejects empty string", () => {
    assert.ok(validateUrl("") !== undefined);
  });

  it("rejects non-http protocols", () => {
    assert.ok(validateUrl("ftp://example.com") !== undefined);
  });

  it("rejects ws:// protocol", () => {
    assert.ok(validateUrl("ws://localhost:3000") !== undefined);
  });

  it("rejects plain hostnames without protocol", () => {
    assert.ok(validateUrl("localhost:3000") !== undefined);
  });

  it("rejects garbage strings", () => {
    assert.ok(validateUrl("not a url at all") !== undefined);
  });
});

describe("validatePort", () => {
  it("accepts a valid free port", async () => {
    const result = await validatePort("3456");
    assert.equal(result, undefined);
  });

  it("rejects empty string", async () => {
    assert.ok((await validatePort("")) !== undefined);
  });

  it("rejects non-numeric input", async () => {
    assert.ok((await validatePort("abc")) !== undefined);
  });

  it("rejects port below 1024", async () => {
    assert.ok((await validatePort("80")) !== undefined);
  });

  it("rejects port above 65535", async () => {
    assert.ok((await validatePort("99999")) !== undefined);
  });

  it("rejects port 1023 (boundary)", async () => {
    assert.ok((await validatePort("1023")) !== undefined);
  });

  it("accepts port 1024 (boundary)", async () => {
    const result = await validatePort("1024");
    // 1024 may or may not be in use; just check it doesn't error on range
    assert.ok(result === undefined || result.includes("already in use"));
  });
});

describe("validateWritableVaultPath", () => {
  it("accepts a writable directory path", () => {
    assert.equal(validateWritableVaultPath(os.tmpdir()), undefined);
  });

  it("accepts a path that does not exist yet (creates it)", () => {
    const tmp = path.join(os.tmpdir(), `companions-test-vault-${Date.now()}`);
    const result = validateWritableVaultPath(tmp);
    assert.equal(result, undefined);
  });

  it("rejects empty string", () => {
    assert.ok(validateWritableVaultPath("") !== undefined);
  });

  it("rejects whitespace only", () => {
    assert.ok(validateWritableVaultPath("   ") !== undefined);
  });
});

describe("isPortFree", () => {
  it("returns true for an unused port", async () => {
    assert.ok(await isPortFree(19234));
  });

  it("returns false for a port that is in use", async () => {
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(19235, "0.0.0.0", resolve));
    try {
      assert.ok(!(await isPortFree(19235)));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
