// Browser-only helpers: the selected File is never read as one movie-sized buffer.
export async function fileFingerprint(file: File) {
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
  const size = new TextEncoder().encode(String(file.size));
  const bytes = new Uint8Array(first.length + last.length + size.length);
  bytes.set(first); bytes.set(last, first.length); bytes.set(size, first.length + last.length);
  return digest(bytes);
}
export async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}
export type UploadStatus = {
  id: string; status: string; uploadStatus: string; bytes: number; receivedBytes: number;
  partBytes: number; clientFingerprint: string; progress: number; error: string | null;
  segmentSeconds?: number; encodingProfile?: string; durationSeconds?: number | null; encryptedBytes?: string; objectCount?: number;
  canRetry: boolean; published: boolean; expiresAt: string;
};
export async function transferFile(file: File, upload: UploadStatus, signal: AbortSignal, acknowledged: (value: UploadStatus) => void) {
  if (file.size !== upload.bytes || await fileFingerprint(file) !== upload.clientFingerprint) throw new Error("Choose the original file to resume this upload.");
  let current = upload;
  while (current.receivedBytes < file.size) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(current.receivedBytes, current.receivedBytes + current.partBytes).arrayBuffer());
    try {
      const next = await uploadRequest(`/uploads/${current.id}/parts`, { method: "PUT", signal, body: bytes,
        headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(current.receivedBytes), "X-Content-SHA256": await digest(bytes) } });
      if (next.receivedBytes <= current.receivedBytes || next.receivedBytes > file.size) throw new Error("Upload progress could not be confirmed. Pause and resume.");
      current = next; acknowledged(current);
    } finally { bytes.fill(0); }
  }
  return uploadRequest(`/uploads/${current.id}/complete`, { method: "POST", signal });
}
export async function uploadRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/admin/video-pipeline${path}`, { ...options, credentials: "same-origin", cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || "The upload could not continue. Retry shortly.");
  return value;
}
