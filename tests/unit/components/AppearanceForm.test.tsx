// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AppearanceForm from "@/app/admin/settings/AppearanceForm";
import { colorsFromSettings } from "@/config/theme";

const { refresh, fetchMock } = vi.hoisted(() => ({ refresh: vi.fn(), fetchMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/ImageUpload", () => ({ default: () => null }));

const initialValues = {
  instance_name: "The Studio", logo_url: "", logo_image_id: "", about_text: "Independent films",
  ...colorsFromSettings({ themePrimary: "#facc15", themeNavBg: "#112233" }),
  theme_font: "Geist", google_analytics_id: "", google_site_verification: "", sentry_dsn: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("AppearanceForm", () => {
  it("updates the real preview as colors change and saves optional overrides", async () => {
    render(<AppearanceForm initialValues={initialValues} />);
    fireEvent.change(screen.getByLabelText("Player background — HEX"), { target: { value: "#203040" } });
    fireEvent.change(screen.getByLabelText("Button text — HEX"), { target: { value: "#111111" } });
    const preview = screen.getByTestId("theme-preview");
    expect(preview.style.getPropertyValue("--theme-media-bg")).toBe("#203040");
    fireEvent.click(within(screen.getByRole("group", { name: "Live Preview" })).getByRole("button", { name: "Video" }));
    expect(screen.getByText("Unlock with Bitcoin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/settings");
    expect(JSON.parse(options.body)).toMatchObject({ theme_media_bg: "#203040", theme_primary_text: "#111111" });
  });

  it("keeps Auto linked to base colors and submits cleared overrides", async () => {
    render(<AppearanceForm initialValues={initialValues} />);
    fireEvent.click(screen.getByRole("button", { name: "Use automatic color for Header background" }));
    fireEvent.change(screen.getByLabelText("Background — HEX"), { target: { value: "#ffffff" } });
    expect(screen.getByTestId("theme-preview").style.getPropertyValue("--theme-nav-bg")).toBe("#ffffff");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).theme_nav_bg).toBe("");
  });

  it("blocks malformed colors while keeping the preview usable", () => {
    render(<AppearanceForm initialValues={initialValues} />);
    const input = screen.getByLabelText("Header background — HEX");
    fireEvent.change(input, { target: { value: "#zzzzzz" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("theme-preview").style.getPropertyValue("--theme-nav-bg")).toBe(initialValues.theme_bg);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resets the complete palette while preserving site identity", async () => {
    render(<AppearanceForm initialValues={initialValues} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Colors" }));
    expect(screen.getByLabelText("Header background — HEX")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ ...colorsFromSettings({}), instance_name: "The Studio", about_text: "Independent films" });
  });

  it("opens and dismisses the preview without saving the draft", () => {
    render(<AppearanceForm initialValues={initialValues} />);
    fireEvent.click(screen.getByRole("button", { name: "Live Preview" }));
    const dialog = screen.getByRole("dialog", { name: "Live Preview" });
    fireEvent.click(within(within(dialog).getByRole("group", { name: "Live Preview" })).getByRole("button", { name: "Video" }));
    expect(within(dialog).getByText("Unlock with Bitcoin")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
