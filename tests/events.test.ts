import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINUBOT_DATA = mkdtempSync(join(tmpdir(), "linubot-ev-"));
const { appendEvent, lastSeq, previewOf, tailEvents } = await import("../src/events/log.ts");

describe("event log", () => {
  it("sequences appends and pages tails", () => {
    appendEvent("bot:a", { kind: "message", from: "user", text: "hi" });
    appendEvent("bot:a", { kind: "thinking", from: "a", text: "hmm", status: "done" });
    appendEvent("bot:a", { kind: "message", from: "a", text: "hello" });
    const page = tailEvents("bot:a", 2);
    assert.deepEqual(page.entries.map((e) => e.seq), [2, 3]);
    assert.equal(page.nextBeforeSeq, 2);
    const first = tailEvents("bot:a", 2, 2);
    assert.deepEqual(first.entries.map((e) => e.seq), [1]);
    assert.equal(first.nextBeforeSeq, null);
  });

  it("previews the latest message and counts seq", () => {
    assert.equal(previewOf("bot:a"), "hello");
    assert.equal(previewOf("bot:empty"), "");
    assert.equal(lastSeq("bot:a"), 3);
  });
});
