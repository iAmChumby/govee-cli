import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";

import { hasInAppNav, markInAppNav, resetInAppNav } from "./client-nav";

const STORAGE_KEY = "filament:has-in-app-nav";

// Mock sessionStorage for Node environment
const mockSessionStorage = {
  store: new Map<string, string>(),
  getItem(key: string) {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.store.set(key, value);
  },
  removeItem(key: string) {
    this.store.delete(key);
  },
  clear() {
    this.store.clear();
  },
};

// Mock window for the client-nav module
const mockWindow = {
  sessionStorage: mockSessionStorage,
};

// @ts-expect-error - mocking global for tests
global.window = mockWindow;
// @ts-expect-error - mocking global for tests
global.sessionStorage = mockSessionStorage;

describe("client-nav pure helpers", () => {
  beforeEach(() => {
    mockSessionStorage.clear();
  });

  afterEach(() => {
    mockSessionStorage.clear();
  });

  describe("hasInAppNav", () => {
    it("returns false when no flag is set", () => {
      assert.equal(hasInAppNav(), false);
    });

    it("returns true when flag is set to 'true'", () => {
      mockSessionStorage.setItem(STORAGE_KEY, "true");
      assert.equal(hasInAppNav(), true);
    });

    it("returns false when flag is set to 'false'", () => {
      mockSessionStorage.setItem(STORAGE_KEY, "false");
      assert.equal(hasInAppNav(), false);
    });

    it("returns false when flag is set to empty string", () => {
      mockSessionStorage.setItem(STORAGE_KEY, "");
      assert.equal(hasInAppNav(), false);
    });
  });

  describe("markInAppNav", () => {
    it("sets the flag in sessionStorage", () => {
      markInAppNav();
      assert.equal(mockSessionStorage.getItem(STORAGE_KEY), "true");
    });

    it("makes hasInAppNav return true", () => {
      markInAppNav();
      assert.equal(hasInAppNav(), true);
    });
  });

  describe("resetInAppNav", () => {
    it("removes the flag from sessionStorage", () => {
      mockSessionStorage.setItem(STORAGE_KEY, "true");
      resetInAppNav();
      assert.equal(mockSessionStorage.getItem(STORAGE_KEY), null);
    });

    it("makes hasInAppNav return false", () => {
      mockSessionStorage.setItem(STORAGE_KEY, "true");
      resetInAppNav();
      assert.equal(hasInAppNav(), false);
    });
  });

  describe("integration", () => {
    it("full cycle: false -> mark -> true -> reset -> false", () => {
      assert.equal(hasInAppNav(), false);
      markInAppNav();
      assert.equal(hasInAppNav(), true);
      resetInAppNav();
      assert.equal(hasInAppNav(), false);
    });
  });
});