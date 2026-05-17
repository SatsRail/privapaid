"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import Modal from "@/components/ui/Modal";
import ImageUpload from "@/components/ui/ImageUpload";

interface EncryptedBlobInfo {
  product_id: string;
  scope: "media" | "channel";
  blob_preview: string | null;
  blob_length: number;
  key_fingerprint: string | null;
  created_at: string | null;
}

interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  currency: string;
  status: string;
  external_ref: string | null;
  has_blob: boolean;
  access_duration_seconds: number;
}

interface MediaFormProps {
  channelId: string;
  channelSlug?: string;
  currency?: string;
  initialData?: {
    _id: string;
    name: string;
    description: string;
    source_url: string;
    media_type: string;
    thumbnail_url: string;
    thumbnail_id: string;
    preview_image_ids?: string[];
    product_ids: string[];
  };
  products?: ProductDetail[];
  encryptedBlobs?: EncryptedBlobInfo[];
}

function ProductCard({
  product: p,
  blob,
  onUpdate,
}: {
  product: ProductDetail;
  blob?: EncryptedBlobInfo;
  onUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState(p.name);
  const [editPrice, setEditPrice] = useState(String(p.price_cents / 100));
  const [editDuration, setEditDuration] = useState(String(p.access_duration_seconds));
  const [editStatus, setEditStatus] = useState(p.status);
  const [editError, setEditError] = useState("");

  async function handleSave() {
    setSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/api/admin/products/${p.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          price_cents: Math.round(parseFloat(editPrice) * 100),
          access_duration_seconds: parseInt(editDuration),
          status: editStatus,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        setEditError(json.error || "Failed to update");
        return;
      }
      setEditing(false);
      onUpdate();
    } catch {
      setEditError("Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-4">
      {/* Header row */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{p.name}</span>
          {p.external_ref && (
            <span className="rounded bg-[var(--theme-bg)] border border-[var(--theme-border)] px-1.5 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
              {p.external_ref}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              p.status === "active"
                ? "bg-green-500/10 text-green-500"
                : "bg-red-500/10 text-red-500"
            }`}
          >
            {p.status}
          </span>
          {!p.has_blob && (
            <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-500">
              no blob
            </span>
          )}
        </div>
        <button
          onClick={() => setEditing(!editing)}
          className="text-xs text-[var(--theme-primary)] hover:underline ml-2 whitespace-nowrap"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {/* Details row */}
      {!editing && (
        <div className="mt-2 flex items-center gap-4 text-sm text-[var(--theme-text-secondary)]">
          <span className="font-medium text-[var(--theme-text)]">
            {formatPrice(p.price_cents, p.currency)}
          </span>
          <span>{formatDuration(p.access_duration_seconds)}</span>
          <span className="font-mono text-xs opacity-60">{p.slug}</span>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--theme-text-secondary)] mb-1">Name</label>
              <input
                className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-sm text-[var(--theme-text)] focus:outline-none focus:ring-1 focus:ring-[var(--theme-primary)]"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--theme-text-secondary)] mb-1">Price ({p.currency})</label>
              <input
                className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-sm text-[var(--theme-text)] focus:outline-none focus:ring-1 focus:ring-[var(--theme-primary)]"
                type="number"
                step="0.01"
                min="0.01"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--theme-text-secondary)] mb-1">Access Duration</label>
              <select
                className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-sm text-[var(--theme-text)] focus:outline-none focus:ring-1 focus:ring-[var(--theme-primary)]"
                value={editDuration}
                onChange={(e) => setEditDuration(e.target.value)}
              >
                <option value="86400">1 day</option>
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
                <option value="7776000">90 days</option>
                <option value="31536000">1 year</option>
                <option value="0">Lifetime</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--theme-text-secondary)] mb-1">Status</label>
              <select
                className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-sm text-[var(--theme-text)] focus:outline-none focus:ring-1 focus:ring-[var(--theme-primary)]"
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          {editError && <p className="text-xs text-red-500">{editError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-[var(--theme-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-md border border-[var(--theme-border)] px-3 py-1 text-xs font-medium text-[var(--theme-text-secondary)] hover:bg-[var(--theme-bg)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Encrypted blob */}
      {blob && (
        <div className="mt-3 border-t border-[var(--theme-border)] pt-2">
          <div className="flex items-center gap-2 text-xs text-[var(--theme-text-secondary)]">
            <span className={`rounded-full px-1.5 py-0.5 font-medium ${
              blob.scope === "channel"
                ? "bg-green-500/10 text-green-500"
                : "bg-blue-500/10 text-blue-500"
            }`}>
              {blob.scope}
            </span>
            {blob.blob_preview ? (
              <span className="font-mono break-all">
                {blob.blob_preview} ({blob.blob_length} chars)
              </span>
            ) : (
              <span className="text-red-400">No encrypted blob</span>
            )}
          </div>
          {blob.key_fingerprint && (
            <div className="mt-0.5 text-xs text-[var(--theme-text-secondary)] opacity-60">
              Key: <span className="font-mono">{blob.key_fingerprint.slice(0, 16)}...</span>
              {blob.created_at && (
                <span className="ml-2">{new Date(blob.created_at).toLocaleDateString()}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "Lifetime";
  if (seconds >= 31536000) return `${Math.round(seconds / 31536000)} year${seconds >= 63072000 ? "s" : ""}`;
  if (seconds >= 2592000) return `${Math.round(seconds / 2592000)} month${seconds >= 5184000 ? "s" : ""}`;
  if (seconds >= 604800) return `${Math.round(seconds / 604800)} week${seconds >= 1209600 ? "s" : ""}`;
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? "s" : ""}`;
  return `${seconds}s`;
}

function formatPrice(cents: number, curr: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: curr,
  }).format(cents / 100);
}

export default function MediaForm({ channelId, channelSlug, initialData, currency = "USD", products: productDetails = [], encryptedBlobs = [] }: MediaFormProps) {
  const router = useRouter();
  const isEditing = !!initialData;

  const [name, setName] = useState(initialData?.name || "");
  const [description, setDescription] = useState(initialData?.description || "");
  const [sourceUrl, setSourceUrl] = useState(initialData?.source_url || "");
  const [mediaType, setMediaType] = useState(initialData?.media_type || "video");
  const [thumbnailUrl] = useState(initialData?.thumbnail_url || "");
  const [thumbnailId, setThumbnailId] = useState(initialData?.thumbnail_id || "");
  const [previewImageIds, setPreviewImageIds] = useState<string[]>(
    initialData?.preview_image_ids || []
  );

  // Photo upload state: holds the GridFS ID + DEK returned by /api/admin/photos.
  // For an existing photo media item being edited, source_url is the GridFS ID;
  // the DEK is unrecoverable from here (lives only in MediaProduct.encrypted_source_url),
  // so editing means re-uploading.
  const [photoDek, setPhotoDek] = useState<string | null>(null);
  const [photoGridFsId, setPhotoGridFsId] = useState<string | null>(
    initialData?.media_type === "photo" ? initialData.source_url : null
  );
  const [photoMime, setPhotoMime] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Product creation — inline on create, modal on edit
  const [createProduct, setCreateProduct] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productName, setProductName] = useState(initialData?.name || "");
  const [price, setPrice] = useState("");
  const [accessDuration, setAccessDuration] = useState(2592000); // 30 days
  const [productTypeId, setProductTypeId] = useState("");
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState("");

  // Fetch product types when needed (inline toggle on create, or modal on edit)
  const shouldFetchTypes = createProduct || showProductModal;
  const { data: productTypesData } = useSWR<{ data: { id: string; name: string }[] }>(
    shouldFetchTypes ? "/api/admin/product-types" : null,
    fetcher
  );
  const productTypes = productTypesData?.data ?? [];

  // Derive effective productTypeId — use first type as default when available
  const effectiveProductTypeId = productTypeId || productTypes[0]?.id || "";

  async function callCreateProduct(mediaId: string): Promise<boolean> {
    const res = await fetch(
      `/api/admin/media/${mediaId}/create-product`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: productName || name,
          price_cents: Math.round(parseFloat(price) * 100),
          access_duration_seconds: accessDuration,
          product_type_id: effectiveProductTypeId,
          // Envelope encryption: the server wraps the DEK under the product key.
          // Only present for photo media; ignored otherwise.
          ...(mediaType === "photo" && photoDek ? { dek: photoDek } : {}),
        }),
      }
    );
    const json = await res.json();
    if (!res.ok) {
      setProductError(json.error || "Failed to create product");
      return false;
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setProductError("");

    // For photo media, source_url is the GridFS ID returned from /api/admin/photos.
    let effectiveSourceUrl = sourceUrl;
    if (mediaType === "photo") {
      if (!photoGridFsId) {
        setError("Upload a photo before saving");
        setLoading(false);
        return;
      }
      // Creating a new photo media requires also creating a product so the DEK
      // gets wrapped under a product key. Without that, the photo is unrecoverable.
      if (!isEditing && (!createProduct || !photoDek || !price)) {
        setError(
          "New photo media must also create a SatsRail product (the DEK is only available right now)."
        );
        setLoading(false);
        return;
      }
      effectiveSourceUrl = photoGridFsId;
    }

    const payload = {
      channel_id: channelId,
      name,
      description,
      source_url: effectiveSourceUrl,
      media_type: mediaType,
      thumbnail_url: thumbnailUrl,
      thumbnail_id: thumbnailId,
      preview_image_ids: previewImageIds,
      // For photo media added to a channel with existing channel products, the
      // server needs the DEK to wrap under each channel product key. For a brand
      // new photo (no existing products), the server skips this branch.
      ...(mediaType === "photo" && photoDek ? { dek: photoDek } : {}),
    };

    const url = isEditing
      ? `/api/admin/media/${initialData._id}`
      : "/api/admin/media";
    const method = isEditing ? "PATCH" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Failed to save");
        return;
      }

      // On create, if product toggle is on, chain the product creation
      if (!isEditing && createProduct && price) {
        const mediaId = json.data?._id || json._id;
        const ok = await callCreateProduct(mediaId);
        if (!ok) {
          // Media was created but product failed — redirect to edit so they can retry
          setError("Media created, but product creation failed. Redirecting to edit...");
          setTimeout(() => {
            router.push(`/admin/channels/${channelId}/media/${mediaId}/edit`);
            router.refresh();
          }, 1500);
          return;
        }
      }

      router.push(`/admin/channels/${channelId}`);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateProductModal(e: React.FormEvent) {
    e.preventDefault();
    setProductLoading(true);
    setProductError("");

    try {
      const ok = await callCreateProduct(initialData!._id);
      if (!ok) return;
      setShowProductModal(false);
      setProductName(name);
      setPrice("");
      router.refresh();
    } catch {
      setProductError("Something went wrong");
    } finally {
      setProductLoading(false);
    }
  }

  const productFields = (
    <>
      <Input
        label="Product Name"
        value={productName}
        onChange={(e) => setProductName(e.target.value)}
        required={createProduct || showProductModal}
      />
      <Input
        label={`Price (${currency.toUpperCase()})`}
        type="number"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        required={createProduct || showProductModal}
        min={0.01}
        step="0.01"
      />
      <Select
        label="Product Type"
        value={effectiveProductTypeId}
        onChange={(e) => setProductTypeId(e.target.value)}
        options={productTypes.map((pt) => ({
          value: pt.id,
          label: pt.name,
        }))}
      />
      <Select
        label="Access Duration"
        value={String(accessDuration)}
        onChange={(e) => setAccessDuration(parseInt(e.target.value))}
        options={[
          { value: "86400", label: "1 day" },
          { value: "604800", label: "7 days" },
          { value: "2592000", label: "30 days" },
          { value: "7776000", label: "90 days" },
          { value: "31536000", label: "1 year" },
          { value: "0", label: "Lifetime" },
        ]}
      />
      {productError && (
        <p className="text-sm text-red-500">{productError}</p>
      )}
    </>
  );

  return (
    <>
      <form onSubmit={handleSubmit} className="max-w-4xl space-y-4">
        {/* Media type controls which fields render below — pin it to the top
            so it's the first thing the editor picks. */}
        <Select
          label="Media Type"
          value={mediaType}
          onChange={(e) => setMediaType(e.target.value)}
          options={[
            { value: "video", label: "Video" },
            { value: "audio", label: "Audio" },
            { value: "article", label: "Article" },
            { value: "photo", label: "Photo" },
            { value: "podcast", label: "Podcast" },
          ]}
        />

        {/* Two-column body: text on the left, images on the right.
            Stacks to a single column on mobile (<768px). */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Left column: identity + source */}
          <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <div className="space-y-1">
          <label className="block text-sm font-medium text-[var(--theme-text)]">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary)]"
          />
        </div>
        {mediaType === "photo" ? (
          <PhotoUploadField
            gridFsId={photoGridFsId}
            previewUrl={photoPreviewUrl}
            mime={photoMime}
            isEditing={isEditing}
            onUploaded={({ gridFsId, dek, mime, previewUrl }) => {
              setPhotoGridFsId(gridFsId);
              setPhotoDek(dek);
              setPhotoMime(mime);
              setPhotoPreviewUrl(previewUrl);
              if (!isEditing && !createProduct) setCreateProduct(true);
            }}
          />
        ) : mediaType === "article" ? (
          <ArticleContentField
            value={sourceUrl}
            onChange={setSourceUrl}
          />
        ) : (
          <Input
            label="Source URL"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            required
            helperText="The plain URL (iframe embed, direct link). Never exposed to clients."
            type="url"
          />
        )}
          </div>

          {/* Right column: visual assets */}
          <div className="space-y-4">
            <ImageUpload
              context="media_thumbnail"
              currentImageId={thumbnailId}
              currentImageUrl={thumbnailUrl}
              onUpload={(id) => setThumbnailId(id)}
              label="Thumbnail"
            />

            {/* Preview Images */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--theme-text)]">
                Preview Images
                <span className="ml-1 font-normal text-[var(--theme-text-secondary)]">
                  ({previewImageIds.length}/6)
                </span>
              </label>
              <p className="text-xs text-[var(--theme-text-secondary)]">
                Static preview images visible to all viewers. Not encrypted.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {previewImageIds.map((imgId, idx) => (
                  <div key={imgId} className="group relative aspect-square overflow-hidden rounded-lg border border-[var(--theme-border)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/images/${imgId}`}
                      alt={`Preview ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setPreviewImageIds((ids) => ids.filter((_, i) => i !== idx))}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
                {previewImageIds.length < 6 && (
                  <PreviewImageSlot
                    onUpload={(id) => setPreviewImageIds((ids) => [...ids, id])}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Inline product creation on new media */}
        {!isEditing && (
          <div className="rounded-lg border border-[var(--theme-border)] p-4">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={createProduct}
                onChange={(e) => {
                  setCreateProduct(e.target.checked);
                  if (e.target.checked && !productName) {
                    setProductName(name);
                  }
                }}
                className="h-4 w-4 rounded border-[var(--theme-border)] accent-[var(--theme-primary)]"
              />
              <span className="text-sm font-medium">Also create a SatsRail product</span>
            </label>
            {createProduct && (
              <div className="mt-4 space-y-4">
                {productFields}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-3">
          <Button type="submit" loading={loading}>
            {isEditing ? "Update" : "Create"} Media
          </Button>
          {isEditing && channelSlug && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.open(`/c/${channelSlug}/${initialData._id}?preview=admin`, "_blank")}
            >
              Preview Content
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>

      {isEditing && (
        <div className="mt-8 border-t border-[var(--theme-border)] pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Products</h3>
              <p className="text-sm text-[var(--theme-text-secondary)]">
                {productDetails.length} product(s) linked
              </p>
            </div>
            <Button onClick={() => setShowProductModal(true)} size="sm">
              Create Product
            </Button>
          </div>
          {productDetails.length > 0 && (
            <div className="mt-4 space-y-4">
              {productDetails.map((p) => {
                const blob = encryptedBlobs.find((b) => b.product_id === p.id || b.product_id === p.slug);
                return (
                  <ProductCard
                    key={p.id}
                    product={p}
                    blob={blob}
                    onUpdate={() => router.refresh()}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Create SatsRail Product"
      >
        <form onSubmit={handleCreateProductModal} className="space-y-4">
          {productFields}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowProductModal(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={productLoading}>
              Create Product
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5MB — matches /api/images cap

interface PhotoUploadFieldProps {
  gridFsId: string | null;
  previewUrl: string | null;
  mime: string | null;
  isEditing: boolean;
  onUploaded: (payload: {
    gridFsId: string;
    dek: string;
    mime: string;
    previewUrl: string;
  }) => void;
}

export function PhotoUploadField({
  gridFsId,
  previewUrl,
  isEditing,
  onUploaded,
}: PhotoUploadFieldProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      setError("Photo must be JPEG, PNG, WebP, or GIF");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setError(`Photo too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/photos", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload failed");
        return;
      }
      // Show a local preview from the just-selected file (the GridFS bytes are
      // ciphertext, so we can't display them directly).
      const localPreview = URL.createObjectURL(file);
      onUploaded({
        gridFsId: data.gridFsId,
        dek: data.dek,
        mime: data.mime,
        previewUrl: localPreview,
      });
    } catch (err) {
      console.error("Photo upload failed", err);
      setError("Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-[var(--theme-text)]">
        Photo
      </label>

      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt="Photo preview"
          className="max-h-80 rounded-md border border-[var(--theme-border)]"
        />
      ) : gridFsId ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-[var(--theme-border)] text-xs text-[var(--theme-text-secondary)]">
          Photo is stored encrypted. Re-upload to replace.
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-[var(--theme-border)] text-xs text-[var(--theme-text-secondary)]">
          No photo uploaded yet
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={handleFile}
        className="hidden"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1.5 text-sm text-[var(--theme-text)] hover:bg-[var(--theme-bg-secondary)] disabled:opacity-50"
        >
          {uploading ? "Uploading…" : gridFsId ? "Replace photo" : "Upload photo"}
        </button>
        <span className="text-xs text-[var(--theme-text-secondary)]">
          JPEG / PNG / WebP / GIF — max 5MB
        </span>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <p className="text-xs text-[var(--theme-text-secondary)]">
        Bytes are encrypted at rest. The decryption key is wrapped under each
        SatsRail product key and never persisted on the server.
        {!isEditing && (
          <>
            {" "}
            You must also create a product before saving — the key is lost
            otherwise.
          </>
        )}
      </p>
    </div>
  );
}

export const ARTICLE_MAX_BYTES = 500_000;

export function ArticleContentField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError("");
    if (file.size > ARTICLE_MAX_BYTES) {
      setFileError(`File too large (${Math.round(file.size / 1024)}KB). Max 500KB.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const text = await file.text();
    onChange(text);
    if (fileRef.current) fileRef.current.value = "";
  }

  const isUrl = /^https?:\/\//i.test(value.trim());
  const byteLen = new globalThis.Blob([value]).size;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-[var(--theme-text)]">
          Article content
        </label>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="text-xs text-[var(--theme-primary)] hover:underline"
        >
          Upload .md file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={handleFile}
          className="hidden"
        />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={14}
        required
        placeholder={"# My article\n\nWrite **markdown** here, or paste a URL to render as an external link card."}
        className="block w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 font-mono text-xs text-[var(--theme-text)] focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary)]"
      />
      {fileError && <p className="text-xs text-red-500">{fileError}</p>}
      <div className="flex items-center justify-between text-xs text-[var(--theme-text-secondary)]">
        <span>
          {isUrl
            ? "URL detected — will render as an external link card."
            : "Markdown — renders inline after payment."}
        </span>
        <span className={byteLen > ARTICLE_MAX_BYTES ? "text-red-500" : ""}>
          {(byteLen / 1024).toFixed(1)}KB / 500KB
        </span>
      </div>
      <p className="text-xs text-[var(--theme-text-secondary)]">
        Content is encrypted and never exposed to viewers without payment.
      </p>
    </div>
  );
}

function PreviewImageSlot({ onUpload }: { onUpload: (id: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("context", "media_preview");
      const res = await fetch("/api/images", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) onUpload(data.image_id);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <button
      type="button"
      onClick={() => fileRef.current?.click()}
      disabled={uploading}
      className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-[var(--theme-border)] text-[var(--theme-text-secondary)] transition-colors hover:border-[var(--theme-primary)] hover:text-[var(--theme-primary)] disabled:opacity-50"
    >
      {uploading ? (
        <svg className="h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFile} className="hidden" />
    </button>
  );
}
