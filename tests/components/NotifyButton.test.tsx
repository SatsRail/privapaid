// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NotifyButton from "@/components/NotifyButton";

// NotifyButton reads `t` from the default LocaleContext (t = (key) => key), so
// with no provider the rendered labels are the i18n keys themselves — we assert
// on those keys + on behavior, which keeps the test independent of copy.

function makeSubscription() {
  return {
    endpoint: "https://push.example.com/endpoint-abc",
    toJSON: () => ({
      endpoint: "https://push.example.com/endpoint-abc",
      keys: { p256dh: "p256", auth: "authkey" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

interface SwMocks {
  register: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

function installPushApis(
  opts: { permission?: NotificationPermission; existingSub?: boolean } = {}
): SwMocks {
  const permission = opts.permission ?? "default";
  const sub = makeSubscription();
  const getSubscription = vi
    .fn()
    .mockResolvedValue(opts.existingSub ? sub : null);
  const subscribe = vi.fn().mockResolvedValue(sub);
  const registration = { pushManager: { getSubscription, subscribe } };
  const register = vi.fn().mockResolvedValue(registration);
  const requestPermission = vi.fn().mockResolvedValue("granted");

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission, requestPermission });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));

  return { register, getSubscription, subscribe, requestPermission };
}

function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("NotifyButton", () => {
  beforeEach(() => {
    // jsdom's built-in localStorage is unreliable in this runner; use a simple
    // in-memory stub so both the component and assertions can read/write it.
    vi.stubGlobal("localStorage", makeLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(navigator, "userAgent");
    vi.clearAllMocks();
  });

  it("renders nothing when push is unsupported (non-iOS)", async () => {
    const { container } = render(
      <NotifyButton channelSlug="ch" vapidPublicKey="key" />
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows the subscribe button + disclosure when supported and permission is default", async () => {
    installPushApis({ permission: "default" });
    render(<NotifyButton channelSlug="ch" vapidPublicKey="key" />);

    const btn = await screen.findByTestId("notify-button");
    expect(btn.textContent).toContain("Notify me of new content");
    expect(screen.getByText("We store an anonymous browser address to notify you \u2014 no email, no account. Turn it off anytime.")).toBeInTheDocument();
  });

  it("shows a denied hint and disables the button when permission is denied", async () => {
    installPushApis({ permission: "denied" });
    render(<NotifyButton channelSlug="ch" vapidPublicKey="key" />);

    const btn = await screen.findByTestId("notify-button");
    expect(btn).toBeDisabled();
    expect(screen.getByText("Notifications are blocked in your browser settings.")).toBeInTheDocument();
  });

  it("subscribes on click: requests permission, registers the SW, POSTs the subscription", async () => {
    const mocks = installPushApis({ permission: "default" });
    render(<NotifyButton channelSlug="my-channel" vapidPublicKey="BKey" />);

    const btn = await screen.findByTestId("notify-button");
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByTestId("notify-button").textContent).toContain(
        "Notifications on"
      )
    );

    expect(mocks.register).toHaveBeenCalledWith("/sw.js");
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true })
    );

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.any(Object)
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.channel_slug).toBe("my-channel");
    expect(body.subscription.endpoint).toBe(
      "https://push.example.com/endpoint-abc"
    );
    expect(localStorage.getItem("privapaid:notify:my-channel")).toBe("true");
  });

  it("shows the iOS Home Screen hint on un-installed iOS Safari", async () => {
    // iOS Safari outside a PWA exposes no PushManager — show the install hint
    // rather than a dead button.
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15",
    });
    render(<NotifyButton channelSlug="ch" vapidPublicKey="key" />);
    expect(
      await screen.findByText("Add this site to your Home Screen to get notifications.")
    ).toBeInTheDocument();
  });

  it("unsubscribes on click when already subscribed (deletes only this channel's row)", async () => {
    installPushApis({ permission: "granted", existingSub: true });
    localStorage.setItem("privapaid:notify:my-channel", "true");

    render(<NotifyButton channelSlug="my-channel" vapidPublicKey="key" />);

    // Starts subscribed (granted permission + stored flag for this channel).
    const btn = await screen.findByTestId("notify-button");
    await waitFor(() =>
      expect(btn.textContent).toContain("Notifications on")
    );

    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByTestId("notify-button").textContent).toContain(
        "Notify me of new content"
      )
    );

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/unsubscribe",
      expect.any(Object)
    );
    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string
    );
    expect(body.endpoint).toBe("https://push.example.com/endpoint-abc");
    expect(body.channel_slug).toBe("my-channel");
    expect(localStorage.getItem("privapaid:notify:my-channel")).toBeNull();
  });

  it("falls back to default + shows an error toast when subscribe fails", async () => {
    installPushApis({ permission: "default" });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    render(<NotifyButton channelSlug="ch" vapidPublicKey="key" />);
    const btn = await screen.findByTestId("notify-button");
    fireEvent.click(btn);

    expect(await screen.findByText("Couldn't enable notifications. Please try again.")).toBeInTheDocument();
    expect(screen.getByTestId("notify-button").textContent).toContain(
      "Notify me of new content"
    );
    expect(localStorage.getItem("privapaid:notify:ch")).toBeNull();
  });

  it("goes to the denied state when the user blocks the permission prompt", async () => {
    const mocks = installPushApis({ permission: "default" });
    mocks.requestPermission.mockResolvedValueOnce("denied");

    render(<NotifyButton channelSlug="ch" vapidPublicKey="key" />);
    const btn = await screen.findByTestId("notify-button");
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText("Notifications are blocked in your browser settings.")).toBeInTheDocument()
    );
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("still clears local state when the unsubscribe network call fails", async () => {
    installPushApis({ permission: "granted", existingSub: true });
    localStorage.setItem("privapaid:notify:my-channel", "true");
    render(<NotifyButton channelSlug="my-channel" vapidPublicKey="key" />);

    const btn = await screen.findByTestId("notify-button");
    await waitFor(() =>
      expect(btn.textContent).toContain("Notifications on")
    );

    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByTestId("notify-button").textContent).toContain(
        "Notify me of new content"
      )
    );
    expect(localStorage.getItem("privapaid:notify:my-channel")).toBeNull();
  });
});
