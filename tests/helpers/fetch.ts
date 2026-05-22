import { vi } from "vitest";

/**
 * Install a `global.fetch` mock from a single handler function.
 *
 *   mockFetch((url, init) => {
 *     if (url === "/api/checkout" && init?.method === "POST") {
 *       return { ok: true, json: async () => ({ token: "tok" }) };
 *     }
 *   });
 *
 * Return `undefined` from the handler to fall through to the default
 * 404 response. The default keeps tests honest — unmocked routes never
 * silently return `ok: true`.
 *
 * Lives in `tests/helpers/` so the same primitive serves component tests
 * and any future integration test that needs to mock fetch.
 */
export type FetchHandler = (url: string, init?: RequestInit) => unknown;

export function mockFetch(handler: FetchHandler): void {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const res = handler(url, init);
    return res ?? { ok: false, status: 404, json: async () => ({}) };
  });
}
