import { beforeEach, describe, expect, it } from "vitest";
import {
  KNOWN_EVENTS,
  channelsForEvent,
  defaultPrefs,
  getPrefs,
  mergePrefs,
  setPrefs,
} from "@/core/notify";
import type { NotificationPrefs } from "@/core/notify";

beforeEach(() => {
  setPrefs(defaultPrefs());
});

describe("default preferences", () => {
  it("enable webhook only", () => {
    const d = defaultPrefs();
    expect(d.channels).toEqual({ webhook: true, slack: false, email: false });
    expect(channelsForEvent(d, "tx.blocked")).toEqual(["webhook"]);
  });

  it("export the known AEGIS event types", () => {
    expect(KNOWN_EVENTS).toContain("tx.blocked");
    expect(KNOWN_EVENTS).toContain("ledger.broken");
    expect(KNOWN_EVENTS.length).toBe(10);
  });
});

describe("channelsForEvent", () => {
  it("honors per-event overrides", () => {
    const prefs: NotificationPrefs = {
      channels: { webhook: true, slack: false, email: true },
      perEvent: { "tx.blocked": ["slack"] },
    };
    expect(channelsForEvent(prefs, "tx.blocked")).toEqual(["slack"]);
    expect(channelsForEvent(prefs, "budget.warning")).toEqual(["webhook", "email"]);
  });

  it("lets an empty override silence an event", () => {
    const prefs = mergePrefs(defaultPrefs(), { perEvent: { "tx.blocked": [] } });
    expect(channelsForEvent(prefs, "tx.blocked")).toEqual([]);
  });
});

describe("mergePrefs", () => {
  it("replaces arrays instead of concatenating", () => {
    const base: NotificationPrefs = {
      channels: { webhook: true, slack: true, email: false },
      perEvent: { "tx.blocked": ["webhook"] },
    };
    const merged = mergePrefs(base, { perEvent: { "tx.blocked": ["slack", "email"] } });
    expect(merged.perEvent["tx.blocked"]).toEqual(["slack", "email"]);
    expect(merged.channels.slack).toBe(true);
  });

  it("merges channel booleans per key", () => {
    const base: NotificationPrefs = {
      channels: { webhook: true, slack: true, email: false },
      perEvent: {},
    };
    const merged = mergePrefs(base, { channels: { webhook: true, slack: true, email: true } });
    expect(merged.channels).toEqual({ webhook: true, slack: true, email: true });
  });
});

describe("module storage", () => {
  it("round-trips through setPrefs/getPrefs", () => {
    setPrefs({ channels: { webhook: false, slack: true, email: true } });
    const got = getPrefs();
    expect(got.channels).toEqual({ webhook: false, slack: true, email: true });
  });

  it("keeps per-key storage independent", () => {
    setPrefs({ channels: { webhook: false, slack: true, email: false } }, "ops@acme.com");
    expect(getPrefs("ops@acme.com").channels.slack).toBe(true);
    expect(getPrefs().channels.webhook).toBe(true);
  });

  it("returns a copy so callers cannot mutate storage", () => {
    setPrefs({ channels: { webhook: false, slack: false, email: false } });
    const got = getPrefs();
    got.channels.email = true;
    expect(getPrefs().channels.email).toBe(false);
  });
});
