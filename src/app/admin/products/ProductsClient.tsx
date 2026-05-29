"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useLocale } from "@/i18n/useLocale";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

interface Blob {
  media_id: string;
  media_name: string;
  media_type: string;
  media_ref: number | null;
  blob_preview: string | null;
  blob_length: number;
  key_fingerprint: string | null;
  created_at: string | null;
}

interface Product {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  status: string;
  access_duration_seconds: number;
  product_type_id: string;
  external_ref: string | null;
  sku: string;
  slug: string;
  old_key?: string;
}

interface ProductType {
  id: string;
  name: string;
  position: number;
}

const DURATION_OPTIONS = [
  { key: "admin.products.duration_1d", value: 86400 },
  { key: "admin.products.duration_7d", value: 604800 },
  { key: "admin.products.duration_30d", value: 2592000 },
  { key: "admin.products.duration_90d", value: 7776000 },
  { key: "admin.products.duration_1y", value: 31536000 },
  { key: "admin.products.duration_lifetime", value: 0 },
];

function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export default function ProductsClient({ currency = "USD" }: { currency?: string }) {
  const { t } = useLocale();

  const { data: productsData, isLoading: productsLoading, error: productsError, mutate: mutateProducts } = useSWR<{ data: Product[] }>(
    "/api/admin/products",
    fetcher
  );
  const { data: typesData, isLoading: typesLoading, mutate: mutateTypes } = useSWR<{ data: ProductType[] }>(
    "/api/admin/product-types",
    fetcher
  );

  const products = productsData?.data ?? [];
  const productTypes = typesData?.data ?? [];
  const loading = productsLoading || typesLoading;
  const [error, setError] = useState("");

  // Product form state
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    price: "",
    product_type_id: "",
    access_duration_seconds: "0",
    status: "active",
  });
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);

  // Blob modal state
  const [blobProduct, setBlobProduct] = useState<Product | null>(null);
  const { data: blobsData, isLoading: blobsLoading } = useSWR<{ data: Blob[] }>(
    blobProduct ? `/api/admin/products/${blobProduct.id}/blobs` : null,
    fetcher
  );

  // Key rotation re-encryption state
  const [reencryptingProductId, setReencryptingProductId] = useState<string | null>(null);
  const [reencryptProgress, setReencryptProgress] = useState<{ current: number; total: number; errors: number } | null>(null);

  // Product type form
  const [showTypeForm, setShowTypeForm] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [typeFormError, setTypeFormError] = useState("");
  const [typeFormLoading, setTypeFormLoading] = useState(false);

  function formatDuration(seconds: number): string {
    if (seconds === 0) return t("admin.products.duration_lifetime");
    const opt = DURATION_OPTIONS.find((d) => d.value === seconds);
    if (opt) return t(opt.key);
    const days = Math.round(seconds / 86400);
    return `${days} day${days !== 1 ? "s" : ""}`;
  }

  async function refetchAll() {
    await Promise.all([mutateProducts(), mutateTypes()]);
  }

  const resetProductForm = () => {
    setFormData({
      name: "",
      price: "",
      product_type_id: productTypes[0]?.id || "",
      access_duration_seconds: "0",
      status: "active",
    });
    setEditingProduct(null);
    setFormError("");
  };

  const openNewProductForm = () => {
    resetProductForm();
    setShowProductForm(true);
  };

  const openEditProductForm = (product: Product) => {
    setEditingProduct(product);
    setFormData({
      name: product.name,
      price: String(product.price_cents / 100),
      product_type_id: product.product_type_id || "",
      access_duration_seconds: String(product.access_duration_seconds),
      status: product.status,
    });
    setFormError("");
    setShowProductForm(true);
  };

  const handleProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormLoading(true);
    setFormError("");

    try {
      const payload = {
        name: formData.name,
        price_cents: Math.round(parseFloat(formData.price) * 100),
        product_type_id: formData.product_type_id,
        access_duration_seconds: Number(formData.access_duration_seconds),
        status: formData.status,
      };

      let res: Response;
      if (editingProduct) {
        res = await fetch(`/api/admin/products/${editingProduct.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch("/api/admin/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || t("admin.products.save_failed"));
      }

      setShowProductForm(false);
      resetProductForm();
      await refetchAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("admin.products.save_failed"));
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteProduct = async (product: Product) => {
    if (!confirm(t("admin.products.delete_confirm", { name: product.name }))) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/products/${product.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || t("admin.products.delete_failed"));
      }
      await refetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.products.delete_failed"));
    }
  };

  const processReencryptLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line);
      if (data.done && data.errors > 0) {
        setError(`Re-encryption completed with ${data.errors} error(s). Old key was NOT cleared — you can retry.`);
      } else if (!data.done) {
        setReencryptProgress({ current: data.current, total: data.total, errors: data.errors || 0 });
      }
    } catch {
      // skip malformed lines
    }
  };

  const readReencryptStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(processReencryptLine);
    }
  };

  const handleReencrypt = async (product: Product) => {
    setReencryptingProductId(product.id);
    setReencryptProgress(null);
    setError("");

    try {
      const res = await fetch(`/api/admin/products/${product.id}/re-encrypt`, {
        method: "POST",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to re-encrypt media");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      await readReencryptStream(reader);
      await mutateProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-encrypt media");
    } finally {
      setReencryptingProductId(null);
      setReencryptProgress(null);
    }
  };

  const handleCreateType = async (e: React.FormEvent) => {
    e.preventDefault();
    setTypeFormLoading(true);
    setTypeFormError("");

    try {
      const res = await fetch("/api/admin/product-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTypeName }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || t("admin.products.types_create_failed"));
      }

      setNewTypeName("");
      setShowTypeForm(false);
      await refetchAll();
    } catch (err) {
      setTypeFormError(
        err instanceof Error ? err.message : t("admin.products.types_create_failed")
      );
    } finally {
      setTypeFormLoading(false);
    }
  };

  const getTypeName = (typeId: string) => {
    return productTypes.find((pt) => pt.id === typeId)?.name || "—";
  };

  if (productsError) {
    return (
      <div className="py-12 text-center text-red-400">
        {t("admin.products.load_failed")}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-[var(--theme-text-secondary)]">
        {t("admin.products.loading")}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Product Types Section */}
      <div className="mb-6 rounded-lg border border-[var(--theme-border)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--theme-text-secondary)]">
            {t("admin.products.types_title")}
          </h3>
          <button
            onClick={() => setShowTypeForm(!showTypeForm)}
            className="text-sm text-[var(--theme-primary)] hover:underline"
          >
            {showTypeForm ? t("admin.products.types_cancel") : t("admin.products.types_add")}
          </button>
        </div>

        {showTypeForm && (
          <form onSubmit={handleCreateType} className="mb-3 flex gap-2">
            <input
              type="text"
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              placeholder={t("admin.products.types_placeholder")}
              className="flex-1 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1.5 text-sm"
              required
            />
            <Button type="submit" size="sm" disabled={typeFormLoading}>
              {typeFormLoading ? "..." : t("admin.products.types_create")}
            </Button>
          </form>
        )}
        {typeFormError && (
          <p className="mb-2 text-sm text-red-400">{typeFormError}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {productTypes.map((pt) => (
            <span
              key={pt.id}
              className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1 text-xs"
            >
              {pt.name}
            </span>
          ))}
          {productTypes.length === 0 && (
            <span className="text-sm text-[var(--theme-text-secondary)]">
              {t("admin.products.types_empty")}
            </span>
          )}
        </div>
      </div>

      {/* Products Section */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("admin.products.list_title")} ({products.length})</h2>
        <button
          onClick={openNewProductForm}
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm hover:opacity-80"
        >
          {t("admin.products.new")}
        </button>
      </div>

      {/* Product Form */}
      {showProductForm && (
        <div className="mb-6 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-4">
          <h3 className="mb-4 font-semibold">
            {editingProduct ? t("admin.products.edit") : t("admin.products.new")}
          </h3>
          {formError && (
            <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {formError}
            </div>
          )}
          <form onSubmit={handleProductSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">{t("admin.products.name")}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {t("admin.products.price")} ({currency.toUpperCase()})
                </label>
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) =>
                    setFormData({ ...formData, price: e.target.value })
                  }
                  className="w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm"
                  required
                  min="0.01"
                  step="0.01"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {t("admin.products.type")}
                </label>
                <select
                  value={formData.product_type_id}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      product_type_id: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm"
                  required
                >
                  <option value="">{t("admin.products.select_type")}</option>
                  {productTypes.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {t("admin.products.duration")}
                </label>
                <select
                  value={formData.access_duration_seconds}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      access_duration_seconds: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm"
                >
                  {DURATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.key)}
                    </option>
                  ))}
                </select>
              </div>
              {editingProduct && (
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    {t("admin.products.status")}
                  </label>
                  <select
                    value={formData.status}
                    onChange={(e) =>
                      setFormData({ ...formData, status: e.target.value })
                    }
                    className="w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm"
                  >
                    <option value="active">{t("admin.products.active")}</option>
                    <option value="inactive">{t("admin.products.inactive")}</option>
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={formLoading}>
                {formLoading
                  ? t("admin.products.saving")
                  : editingProduct
                    ? t("admin.products.update")
                    : t("admin.products.create")}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setShowProductForm(false);
                  resetProductForm();
                }}
                className="rounded-md border border-[var(--theme-border)] px-4 py-2 text-sm hover:bg-[var(--theme-bg)]"
              >
                {t("admin.products.cancel")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Products Table */}
      <div className="overflow-hidden rounded-lg border border-[var(--theme-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--theme-bg-secondary)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.name")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                Ref
              </th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.price")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.type")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.duration")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.status")}
              </th>
              <th className="px-4 py-3 text-right font-medium text-[var(--theme-text-secondary)]">
                {t("admin.products.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--theme-border)]">
            {products.map((product) => (
              <tr
                key={product.id}
                className="hover:bg-[var(--theme-bg-secondary)]"
              >
                <td className="px-4 py-3 font-medium">
                  <button
                    onClick={() => setBlobProduct(product)}
                    className="text-left hover:text-[var(--theme-primary)] hover:underline"
                  >
                    {product.name}
                  </button>
                </td>
                <td className="px-4 py-3">
                  {product.external_ref ? (
                    <span className="rounded bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] px-1.5 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
                      {product.external_ref}
                    </span>
                  ) : (
                    <span className="text-[var(--theme-text-secondary)]">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {formatPrice(product.price_cents, product.currency)}
                </td>
                <td className="px-4 py-3 text-[var(--theme-text-secondary)]">
                  {getTypeName(product.product_type_id)}
                </td>
                <td className="px-4 py-3 text-[var(--theme-text-secondary)]">
                  {formatDuration(product.access_duration_seconds)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      product.status === "active"
                        ? "bg-green-500/20 text-green-400"
                        : "bg-zinc-500/20 text-zinc-400"
                    }`}
                  >
                    {product.status}
                  </span>
                  {product.old_key && (
                    <span className="ml-1 inline-block rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400">
                      Rotation Pending
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {product.old_key && (
                    <button
                      onClick={() => handleReencrypt(product)}
                      disabled={reencryptingProductId === product.id}
                      className="mr-3 text-yellow-400 hover:underline disabled:opacity-50"
                    >
                      {reencryptingProductId === product.id && reencryptProgress
                        ? `${reencryptProgress.current} / ${reencryptProgress.total}`
                        : reencryptingProductId === product.id
                          ? "..."
                          : "Re-encrypt Media"}
                    </button>
                  )}
                  <button
                    onClick={() => openEditProductForm(product)}
                    className="mr-3 text-[var(--theme-primary)] hover:underline"
                  >
                    {t("admin.products.edit_action")}
                  </button>
                  <button
                    onClick={() => handleDeleteProduct(product)}
                    className="text-red-400 hover:underline"
                  >
                    {t("admin.products.delete")}
                  </button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[var(--theme-text-secondary)]"
                >
                  {t("admin.products.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Encrypted Blobs Modal */}
      <Modal
        open={!!blobProduct}
        onClose={() => setBlobProduct(null)}
        title={blobProduct ? `Encrypted Blobs — ${blobProduct.name}` : ""}
      >
        {blobsLoading ? (
          <p className="py-4 text-center text-sm text-[var(--theme-text-secondary)]">Loading...</p>
        ) : !blobsData?.data?.length ? (
          <p className="py-4 text-center text-sm text-[var(--theme-text-secondary)]">No encrypted blobs for this product.</p>
        ) : (
          <div className="max-h-96 space-y-3 overflow-y-auto">
            {blobsData.data.map((blob) => (
              <div
                key={blob.media_id}
                className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {blob.media_name}
                    {blob.media_ref != null && (
                      <span className="ml-2 rounded bg-[var(--theme-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
                        md_{blob.media_ref}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-[var(--theme-text-secondary)]">
                    {blob.created_at ? new Date(blob.created_at).toLocaleDateString() : "—"}
                  </span>
                </div>
                {blob.blob_preview ? (
                  <div className="rounded bg-[var(--theme-bg)] px-3 py-2 font-mono text-xs break-all text-[var(--theme-text-secondary)]">
                    {blob.blob_preview}
                    <span className="ml-2 opacity-60">({blob.blob_length} chars)</span>
                  </div>
                ) : (
                  <div className="text-xs text-red-400">No encrypted blob</div>
                )}
                {blob.key_fingerprint && (
                  <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                    Key: <span className="font-mono">{blob.key_fingerprint.slice(0, 16)}...</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
