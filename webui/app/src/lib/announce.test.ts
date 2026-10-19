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

  it("announces a different message after an identical one collapses", () => {
    const heard: string[] = [];
    subscribeAnnouncements((message) => heard.push(message));

    announce("Schedule saved");
    announce("Room scene \"Evenings\" saved");
    announce("Schedule saved");

    assert.deepEqual(heard, [
      "Schedule saved",
      "Room scene \"Evenings\" saved",
      "Schedule saved",
    ]);
  });
});
