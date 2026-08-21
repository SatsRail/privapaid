import config from "@/config/instance";

interface SatsRailRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  secretKey: string;
}

interface SatsRailProduct {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  sku: string;
  slug: string;
  status: string;
  image_url: string;
  access_duration_seconds: number;
  product_type_id: string;
  external_ref: string | null;
  key?: string;
  old_key?: string;
  metadata: Record<string, unknown>;
}

interface SatsRailProductType {
  object: string;
  id: string;
  name: string;
  position: number;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface SatsRailListResponse<T> {
  object: string;
  data: T[];
  meta: Record<string, unknown>;
}

interface SatsRailOrder {
  id: string;
  status: string;
  total_cents: number;
  currency: string;
  created_at: string;
}

interface SatsRailCheckoutSession {
  token: string;
  checkout_url: string;
  status: string;
  expires_at: string;
}

interface SatsRailTokenUsage {
  rpm_limit: number;
  monthly_request_count: number;
  current_rpm: number;
}

interface SatsRailPayment {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  product_id: string;
  order_id: string;
  created_at: string;
}

interface SatsRailMerchant {
  id: string;
  name: string;
  email: string;
  status: string;
  currency: string;
  locale: string;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

interface SatsRailSessionMerchant {
  id: string;
  name: string;
  logo_url: string | null;
  currency: string;
  role: "owner" | "manager" | "accountant";
}

interface SatsRailSessionResponse {
  session_token: string;
  merchants: SatsRailSessionMerchant[];
}

interface SatsRailExchangeCountry {
  id: string;
  name: string;
  iso_code: string;
}

interface SatsRailExchange {
  id: string;
  name: string;
  url: string;
  promoted: boolean;
  min_transaction_sats: number | null;
  notes: string | null;
  logo_url: string | null;
  countries: SatsRailExchangeCountry[];
}

/**
 * Raised when SatsRail answers with a non-2xx status. Carrying the status
 * lets callers separate a genuine 404 from an unreachable host or a rejected
 * merchant key — a transport failure (DNS, TLS, timeout) never produces one
 * of these, it surfaces as the underlying fetch TypeError.
 *
 * The message shape is load-bearing: existing callers match on the status
 * digits inside it.
 */
export class SatsRailApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`SatsRail API error ${status}: ${JSON.stringify(body)}`);
    this.name = "SatsRailApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * SatsRail API client for server-side calls.
 * All methods require a sk_live_ secret key.
 */
interface CheckoutStatus {
  status: "pending" | "completed" | "expired";
  payment_request?: string;
  time_remaining?: number;
  items?: { order_item_id: string; key: string }[];
  access_token?: string;
  access_duration_seconds?: number;
  redirect_url?: string;
  order_id?: string;
  order_number?: string;
}

/**
 * The Stream UI uses `0` to represent "Lifetime" access; the SatsRail Portal
 * represents it as a `null`/absent field and rejects `0` with a validation
 * error (must be > 0). Strip `access_duration_seconds: 0` before sending so
 * Portal treats the product as lifetime-access.
 */
export function normalizeLifetime<T extends { access_duration_seconds?: number | null }>(
  data: T
): T {
  if (data.access_duration_seconds === 0 || data.access_duration_seconds === null) {
    // Drop the field entirely — Portal interprets absence as lifetime
    const { access_duration_seconds: _drop, ...rest } = data;
    void _drop;
    return rest as T;
  }
  return data;
}

class SatsRailClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.satsrail.apiUrl;
  }

  /** Portal root URL (strips /api/v1 suffix) */
  private get portalUrl(): string {
    return this.baseUrl.replace(/\/api\/v1\/?$/, "");
  }

  private async request<T>(
    path: string,
    options: SatsRailRequestOptions
  ): Promise<T> {
    const { method = "GET", body, secretKey } = options;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new SatsRailApiError(res.status, error);
    }

    if (res.status === 204) return undefined as T;
    return res.json();
  }

  // --- Products ---

  async createProduct(
    secretKey: string,
    data: {
      name: string;
      price_cents: number;
      currency?: string;
      access_duration_seconds?: number;
      image_url?: string;
      product_type_id?: string;
      external_ref?: string;
    }
  ): Promise<SatsRailProduct> {
    return this.request<SatsRailProduct>("/m/products", {
      method: "POST",
      secretKey,
      body: { product: normalizeLifetime(data) },
    });
  }

  async getProduct(
    secretKey: string,
    productId: string
  ): Promise<SatsRailProduct> {
    return this.request<SatsRailProduct>(`/m/products/${productId}`, {
      secretKey,
    });
  }

  async listProducts(
    secretKey: string,
    filters?: Record<string, string>
  ): Promise<SatsRailListResponse<SatsRailProduct>> {
    let path = "/m/products";
    if (filters) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        params.append(`q[${key}]`, value);
      }
      path += `?${params.toString()}`;
    }
    return this.request<SatsRailListResponse<SatsRailProduct>>(path, {
      secretKey,
    });
  }

  async getProductKey(
    secretKey: string,
    productId: string
  ): Promise<{ key: string; key_fingerprint: string }> {
    return this.request<{ key: string; key_fingerprint: string }>(`/m/products/${productId}/key`, {
      secretKey,
    });
  }

  async rotateProductKey(
    secretKey: string,
    productId: string
  ): Promise<{ key: string; previous_key: string }> {
    return this.request<{ key: string; previous_key: string }>(`/m/products/${productId}/rotate_key`, {
      method: "POST",
      secretKey,
    });
  }

  async clearOldKey(
    secretKey: string,
    productId: string
  ): Promise<SatsRailProduct> {
    return this.request<SatsRailProduct>(`/m/products/${productId}/clear_old_key`, {
      method: "POST",
      secretKey,
    });
  }

  async updateProduct(
    secretKey: string,
    productId: string,
    data: {
      name?: string;
      price_cents?: number;
      status?: string;
      access_duration_seconds?: number;
      product_type_id?: string;
    }
  ): Promise<SatsRailProduct> {
    return this.request<SatsRailProduct>(`/m/products/${productId}`, {
      method: "PATCH",
      secretKey,
      body: { product: normalizeLifetime(data) },
    });
  }

  async deleteProduct(
    secretKey: string,
    productId: string
  ): Promise<void> {
    await this.request<void>(`/m/products/${productId}`, {
      method: "DELETE",
      secretKey,
    });
  }

  // --- Product Types ---

  async listProductTypes(
    secretKey: string
  ): Promise<SatsRailListResponse<SatsRailProductType>> {
    return this.request<SatsRailListResponse<SatsRailProductType>>(
      "/m/product_types",
      { secretKey }
    );
  }

  async createProductType(
    secretKey: string,
    data: { name: string; external_ref?: string }
  ): Promise<SatsRailProductType> {
    return this.request<SatsRailProductType>("/m/product_types", {
      method: "POST",
      secretKey,
      body: { product_type: data },
    });
  }

  // --- Orders ---

  async createOrder(
    secretKey: string,
    data: Record<string, unknown>
  ): Promise<SatsRailOrder> {
    return this.request<SatsRailOrder>("/m/orders", {
      method: "POST",
      secretKey,
      body: data,
    });
  }

  async getOrder(secretKey: string, orderId: string): Promise<SatsRailOrder> {
    return this.request<SatsRailOrder>(`/m/orders/${orderId}`, { secretKey });
  }

  // --- Checkout Sessions ---

  async createCheckoutSession(
    secretKey: string,
    data: Record<string, unknown>
  ): Promise<SatsRailCheckoutSession> {
    return this.request<SatsRailCheckoutSession>("/m/checkout_sessions", {
      method: "POST",
      secretKey,
      body: data,
    });
  }

  // --- API Token Usage ---

  async getTokenUsage(
    secretKey: string,
    tokenId: string
  ): Promise<SatsRailTokenUsage> {
    return this.request<SatsRailTokenUsage>(`/m/api_tokens/${tokenId}/usage`, {
      secretKey,
    });
  }

  // --- Access Verification (merchant-authenticated) ---

  async verifyAccess(secretKey: string, accessToken: string): Promise<{
    key: string;
    remaining_seconds: number;
  }> {
    return this.request(`/m/access/verify`, {
      method: "POST",
      secretKey,
      body: { access_token: accessToken },
    });
  }

  // --- Payments ---

  async listPayments(
    secretKey: string,
    params?: { page?: number; per_page?: number }
  ): Promise<SatsRailPayment[]> {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.per_page) query.set("per_page", String(params.per_page));
    const qs = query.toString();
    return this.request<SatsRailPayment[]>(
      `/m/payments${qs ? `?${qs}` : ""}`,
      { secretKey }
    );
  }

  // --- Merchant ---

  async getMerchant(secretKey: string): Promise<SatsRailMerchant> {
    return this.request<SatsRailMerchant>("/m/merchant", { secretKey });
  }

  // --- Sessions (no Bearer token required) ---

  async createSession(
    email: string,
    password: string,
    apiUrl?: string
  ): Promise<SatsRailSessionResponse> {
    const base = apiUrl || this.baseUrl;
    const res = await fetch(`${base}/m/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new SatsRailApiError(res.status, error);
    }

    return res.json();
  }

  // --- Public: Checkout (no auth required) ---

  async getCheckoutQr(token: string): Promise<string> {
    const res = await fetch(`${this.portalUrl}/checkout/${token}/qr`);
    if (!res.ok) throw new Error(`Failed to fetch checkout QR: ${res.status}`);
    return res.text();
  }

  async getCheckoutStatus(token: string): Promise<CheckoutStatus> {
    const res = await fetch(`${this.portalUrl}/checkout/${token}/status`);
    if (!res.ok) throw new Error(`Failed to fetch checkout status: ${res.status}`);
    return res.json();
  }

  // --- Public: Exchanges ---

  async getExchanges(): Promise<SatsRailExchange[]> {
    const res = await fetch(`${this.baseUrl}/pub/exchanges`);
    if (!res.ok) {
      throw new Error(`Failed to fetch exchanges: ${res.status}`);
    }
    const data = await res.json();
    return data.exchanges;
  }
}

export const satsrail = new SatsRailClient();

export type {
  CheckoutStatus,
  SatsRailProduct,
  SatsRailProductType,
  SatsRailListResponse,
  SatsRailOrder,
  SatsRailCheckoutSession,
  SatsRailTokenUsage,
  SatsRailPayment,
  SatsRailExchange,
  SatsRailExchangeCountry,
  SatsRailMerchant,
  SatsRailSessionMerchant,
  SatsRailSessionResponse,
};
