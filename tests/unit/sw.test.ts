import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// public/sw.js is plain browser JS (uses the `self` global + addEventListener),
// so it isn't importable as a module. We load the source into a controlled fake
// `self`, capture the handlers it registers, then drive them with synthetic
// push / notificationclick events — exercising the actual notification logic.

interface FakeSelf {
  handlers: Record<string, (event: unknown) => void>;
  addEventListener: (type: string, fn: (event: unknown) => void) => void;
  registration: { showNotification: ReturnType<typeof vi.fn> };
  clients: {
    matchAll: ReturnType<typeof vi.fn>;
    openWindow: ReturnType<typeof vi.fn>;
  };
}

function loadServiceWorker(): FakeSelf {
  const src = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  const handlers: Record<string, (event: unknown) => void> = {};
  const self: FakeSelf = {
    handlers,
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined) },
    clients: {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow: vi.fn().mockResolvedValue(undefined),
    },
  };
  // Run the worker source with our fake `self` bound.
  new Function("self", src)(self);
  return self;
}

describe("public/sw.js", () => {
  it("registers push and notificationclick handlers", () => {
    const sw = loadServiceWorker();
    expect(typeof sw.handlers.push).toBe("function");
    expect(typeof sw.handlers.notificationclick).toBe("function");
  });

  it("shows a notification built from the push payload", () => {
    const sw = loadServiceWorker();
    sw.handlers.push({
      data: {
        json: () => ({
          title: "Demo Studio",
          body: "New: Clip",
          url: "/c/demo/abc",
          tag: "demo",
        }),
      },
      waitUntil: () => {},
    });
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      "Demo Studio",
      expect.objectContaining({
        body: "New: Clip",
        tag: "demo",
        data: { url: "/c/demo/abc" },
      })
    );
  });

  it("falls back to a default title when the push has no data", () => {
    const sw = loadServiceWorker();
    sw.handlers.push({ data: null, waitUntil: () => {} });
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      "New content",
      expect.any(Object)
    );
  });

  it("opens the deep-link URL on notificationclick", async () => {
    const sw = loadServiceWorker();
    const close = vi.fn();
    const waited: Promise<unknown>[] = [];
    sw.handlers.notificationclick({
      notification: { data: { url: "/c/demo/abc" }, close },
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    });
    expect(close).toHaveBeenCalled();
    // Let the matchAll().then(...) chain resolve before asserting openWindow.
    await Promise.all(waited);
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/c/demo/abc");
  });
});
