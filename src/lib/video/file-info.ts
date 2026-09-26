// Preview-only metadata. The worker independently validates every source.
export function localVideoInfo(file: File, signal: AbortSignal): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video"), url = URL.createObjectURL(file);
    video.preload = "metadata";
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); video.onloadedmetadata = null; video.onerror = null; video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); };
    const abort = () => { finish(); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { finish(); reject(new Error("METADATA_UNAVAILABLE")); }, 15000);
    video.onloadedmetadata = () => { const value = { duration: video.duration, width: video.videoWidth, height: video.videoHeight }; finish(); resolve(value); };
    video.onerror = () => { finish(); reject(new Error("METADATA_UNAVAILABLE")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else video.src = url;
  });
}
