import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { announce, subscribeAnnouncements } from "./announce";

describe("announce bus", () => {
  it("delivers announcements to subscribers", () => {
    const heard: string[] = [];
    const unsubscribe = subscribeAnnouncements((message) => heard.push(message));

    announce("Room scene \"Mornings\" saved");

    assert.deepEqual(heard, ["Room scene \"Mornings\" saved"]);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const heard: string[] = [];
    const unsubscribe = subscribeAnnouncements((message) => heard.push(message));
    unsubscribe();

    announce("Room scene \"Mornings\" saved");

    assert.deepEqual(heard, []);
  });

  it("collapses consecutive identical messages into one announcement", () => {
    const heard: string[] = [];
    subscribeAnnouncements((message) => heard.push(message));

    announce("Schedule saved");
    announce("Schedule saved");
    announce("Schedule saved");

    assert.deepEqual(heard, ["Schedule saved"]);
  });

  it("re-announces an earlier message once a different one intervened", () => {
    const heard: string[] = [];
    subscribeAnnouncements((message) => heard.push(message));

    // `lastAnnounced` is module-level, so start from a message no other
    // test uses; what is under test is only the collapse behaviour.
    announce("Brightness 40% set");
    announce("Schedule updated");
    announce("Brightness 40% set");

    assert.deepEqual(heard, [
      "Brightness 40% set",
      "Schedule updated",
      "Brightness 40% set",
    ]);
  });
});
