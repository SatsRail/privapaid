// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockFetch } from "../../helpers/fetch";
import { useMediaAccess } from "@/lib/use-media-access";

/**
 * Specs pinning the single-source-of-truth access hook. Every UI surface
 * (paywall, header pill, comments form) reads access state from here, so
 * these tests are guarding the architectural contract — not just one
 * component's branches.
 */
describe("useMediaAccess", () => {
  const baseParams = {
    mediaId: "media-1",
    products: [
      { productId: "prod-1", encryptedBlob: "blob-1", keyFingerprint: "fp-1" },
    ],
  };

  beforeEach(() => {
    mockFetch(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits to 'inactive' (no_cookie) when the SSR didn't find a stored product macaroon", async () => {
    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: [] })
    );
    // No network roundtrip — the server already told us via storedProductIds
    // that the cookie has nothing for these products.
    expect(result.current.access).toEqual({ status: "inactive", reason: "no_cookie" });
  });

  it("starts in 'loading', then transitions to 'active' on a successful unlock", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            key: "K1",
            key_fingerprint: "fp-1",
            encrypted_blob: "blob-1",
            product_id: "prod-1",
            remaining_seconds: 604800,
          }),
        };
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );

    expect(result.current.access.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.access.status).toBe("active");
    });

    expect(result.current.access).toEqual({
      status: "active",
      productId: "prod-1",
      key: "K1",
      encryptedBlob: "blob-1",
      remainingSeconds: 604800,
    });
  });

  it("transitions to 'inactive' (portal_rejected) when the unlock endpoint returns 401", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return { ok: false, status: 401, json: async () => ({}) };
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );

    await waitFor(() => {
      expect(result.current.access.status).toBe("inactive");
    });
    if (result.current.access.status === "inactive") {
      expect(result.current.access.reason).toBe("portal_rejected");
    }
  });

  it("transitions to 'inactive' (transient) on 5xx so the user is NOT permanently locked", async () => {
    // The cookie isn't cleared on transient failures (the route was changed
    // to preserve cookies on 410 too). The hook just reports "no access
    // right now" — UI can show a soft "couldn't verify" card and a refresh
    // brings the user back.
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return { ok: false, status: 500, json: async () => ({}) };
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );

    await waitFor(() => {
      expect(result.current.access.status).toBe("inactive");
    });
    if (result.current.access.status === "inactive") {
      expect(result.current.access.reason).toBe("transient");
    }
  });

  it("transitions to 'inactive' (transient) on a network error", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        throw new Error("network down");
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );

    await waitFor(() => {
      expect(result.current.access.status).toBe("inactive");
    });
    if (result.current.access.status === "inactive") {
      expect(result.current.access.reason).toBe("transient");
    }
  });

  it("treats a 200 with missing key/blob as 'inactive' (transient) — defensive, not crash", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return { ok: true, status: 200, json: async () => ({ remaining_seconds: 100 }) };
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );

    await waitFor(() => {
      expect(result.current.access.status).toBe("inactive");
    });
  });

  it("`claim` lets a fresh payment activate access WITHOUT a server roundtrip", async () => {
    // After a successful checkout the portal already gave us the key + TTL
    // in the checkout completion payload. Re-asking the server would be
    // wasteful and racy. `claim` injects that data straight into hook state.
    mockFetch(() => undefined); // any unexpected fetch would 404

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: [] })
    );
    expect(result.current.access).toEqual({ status: "inactive", reason: "no_cookie" });

    act(() => {
      result.current.claim({
        productId: "prod-1",
        key: "Kfresh",
        remainingSeconds: 604800,
        encryptedBlob: "blob-1",
      });
    });

    expect(result.current.access).toEqual({
      status: "active",
      productId: "prod-1",
      key: "Kfresh",
      remainingSeconds: 604800,
      encryptedBlob: "blob-1",
    });
  });

  describe("cross-tab access sync", () => {
    it("a 'claimed' BroadcastChannel message triggers a server re-check on the listening tab", async () => {
      // Tab A pays and broadcasts. Tab B's hook should hear the broadcast
      // and call /api/media/[id]/unlock — at this point the browser cookie
      // is set (cookies are cross-tab on a single origin), so the unlock
      // call returns 200 and access becomes active.
      let nextStatus = 401;
      mockFetch((url) => {
        if (url === "/api/media/media-1/unlock") {
          if (nextStatus === 401) {
            return { ok: false, status: 401, json: async () => ({}) };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              key: "Kbroadcast",
              encrypted_blob: "blob-1",
              product_id: "prod-1",
              remaining_seconds: 604800,
            }),
          };
        }
      });

      const { result } = renderHook(() =>
        useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
      );

      // Mount-time check fails → inactive.
      await waitFor(() => expect(result.current.access.status).toBe("inactive"));

      // Simulate Tab A paying: cookie is now valid → broadcast.
      nextStatus = 200;
      await act(async () => {
        const channel = new BroadcastChannel("privapaid:access:media-1");
        channel.postMessage({ type: "claimed", mediaId: "media-1", productId: "prod-1" });
        channel.close();
        // BroadcastChannel delivery is async — let microtasks drain.
        await new Promise((r) => setTimeout(r, 0));
      });

      await waitFor(() => expect(result.current.access.status).toBe("active"));
      if (result.current.access.status === "active") {
        expect(result.current.access.key).toBe("Kbroadcast");
      }
    });

    it("`claim` broadcasts to sibling tabs (the message side of the cross-tab contract)", async () => {
      mockFetch(() => undefined);

      // Sibling tab listener captures whatever the claiming tab posts.
      const received: unknown[] = [];
      const sibling = new BroadcastChannel("privapaid:access:media-1");
      sibling.onmessage = (e: MessageEvent) => received.push(e.data);

      const { result } = renderHook(() =>
        useMediaAccess({ ...baseParams, storedProductIds: [] })
      );

      act(() => {
        result.current.claim({
          productId: "prod-1",
          key: "K",
          remainingSeconds: 604800,
          encryptedBlob: "blob-1",
        });
      });

      await waitFor(() => expect(received.length).toBeGreaterThan(0));
      expect(received[0]).toMatchObject({
        type: "claimed",
        mediaId: "media-1",
        productId: "prod-1",
      });
      // The message MUST NOT contain the decryption key — receivers re-fetch
      // from the server. Keep the key out of the postMessage queue entirely.
      expect(JSON.stringify(received[0])).not.toContain("K");

      sibling.close();
    });

    it("a different-media broadcast is ignored (channels scoped by mediaId)", async () => {
      // Each media has its own channel name. A claim on media-2 must NOT
      // wake the hook for media-1.
      let fetchCount = 0;
      mockFetch((url) => {
        if (url === "/api/media/media-1/unlock") {
          fetchCount++;
          return { ok: false, status: 401, json: async () => ({}) };
        }
      });

      const { result } = renderHook(() =>
        useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
      );
      await waitFor(() => expect(result.current.access.status).toBe("inactive"));
      const fetchesBefore = fetchCount;

      // Broadcast on a different channel.
      await act(async () => {
        const other = new BroadcastChannel("privapaid:access:media-2");
        other.postMessage({ type: "claimed", mediaId: "media-2", productId: "prod-X" });
        other.close();
        await new Promise((r) => setTimeout(r, 10));
      });

      // No extra fetch fired — the listener filters by mediaId on its own
      // channel name; cross-channel messages don't reach it.
      expect(fetchCount).toBe(fetchesBefore);
    });

    it("visibility change → 'visible' re-checks access even when the SSR storedProductIds was empty", async () => {
      // The cross-tab case where Tab B opened BEFORE Tab A's payment: SSR
      // saw no cookie, so the hook short-circuited to no_cookie. When the
      // user comes back to Tab B (visibility transitions to visible), we
      // MUST re-fetch — the cookie may have been set in the meantime.
      let nextStatus = 401;
      let fetchedAfterVisible = false;
      mockFetch((url) => {
        if (url === "/api/media/media-1/unlock") {
          if (nextStatus === 401) {
            return { ok: false, status: 401, json: async () => ({}) };
          }
          fetchedAfterVisible = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              key: "Kvis",
              encrypted_blob: "blob-1",
              product_id: "prod-1",
              remaining_seconds: 604800,
            }),
          };
        }
      });

      const { result } = renderHook(() =>
        useMediaAccess({ ...baseParams, storedProductIds: [] })
      );
      // No cookie at SSR → starts inactive without a fetch.
      expect(result.current.access).toEqual({ status: "inactive", reason: "no_cookie" });

      // Cookie has been set in the browser (by Tab A) — simulate by flipping
      // the mock — then fire visibilitychange.
      nextStatus = 200;
      await act(async () => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((r) => setTimeout(r, 0));
      });

      await waitFor(() => expect(result.current.access.status).toBe("active"));
      expect(fetchedAfterVisible).toBe(true);
    });

    it("does NOT re-fetch on visibility change when access is already active (avoids unnecessary load)", async () => {
      let fetchCount = 0;
      mockFetch((url) => {
        if (url === "/api/media/media-1/unlock") {
          fetchCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              key: "K",
              encrypted_blob: "blob-1",
              product_id: "prod-1",
              remaining_seconds: 604800,
            }),
          };
        }
      });

      const { result } = renderHook(() =>
        useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
      );
      await waitFor(() => expect(result.current.access.status).toBe("active"));
      const fetchesAtActive = fetchCount;

      // Switch tabs and come back — should NOT trigger another unlock call.
      await act(async () => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(fetchCount).toBe(fetchesAtActive);
    });
  });

  it("`refresh` re-runs the unlock check (used when a privileged write returns 401)", async () => {
    let nextResponse: "401" | "200" = "401";
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        if (nextResponse === "401") {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            key: "Kafter",
            encrypted_blob: "blob-1",
            product_id: "prod-1",
            remaining_seconds: 100,
          }),
        };
      }
    });

    const { result } = renderHook(() =>
      useMediaAccess({ ...baseParams, storedProductIds: ["prod-1"] })
    );
    await waitFor(() => {
      expect(result.current.access.status).toBe("inactive");
    });

    // Server-side state changed; ask the hook to re-check.
    nextResponse = "200";
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.access.status).toBe("active");
    if (result.current.access.status === "active") {
      expect(result.current.access.key).toBe("Kafter");
    }
  });
});
