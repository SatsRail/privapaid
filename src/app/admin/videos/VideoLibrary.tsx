"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { uploadRequest } from "@/lib/video/upload-client";
import VideoCapacity, { gib } from "@/components/VideoCapacity";
import type { listAssets } from "@/lib/video/assets";
type Page = Awaited<ReturnType<typeof listAssets>>;
export default function VideoLibrary() {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(""), [search, setSearch] = useState(""), [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(false), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    uploadRequest(`/assets?limit=25&q=${encodeURIComponent(search)}${cursor ? `&cursor=${cursor}` : ""}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setPage(result); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, cursor, revision]);
  return <><VideoCapacity />
    <form onSubmit={e => { e.preventDefault(); setLoading(true); setCursor(null); setSearch(query.trim()); setRevision(n => n + 1); }} className="flex gap-3">
      <label>Find a video<input value={query} maxLength={100} onChange={e => setQuery(e.target.value)} className="ml-3 rounded border p-2" /></label>
      <button type="submit" className="rounded border px-3">Search</button>
    </form>
    {error && <p role="alert">The library could not be loaded. Try searching again.</p>}
    {loading ? <p role="status">Loading videos…</p> : <ul className="divide-y divide-[var(--theme-border)]">{page?.items.map(item => {
      const latest = item.versions[0];
      return <li key={item.id} className="py-4">
        <Link className="font-semibold underline" href={`/admin/channels/${item.media.channelId}/media/${item.mediaId}/video`}>{item.media.name}</Link>
        <p className="text-sm">Latest version: {latest?.status || "not started"} · {latest?.progress || 0}% · {gib(latest?.encryptedBytes || "0")} GiB</p>
        <p className="text-sm">{item.publishedVersion ? "Published version available" : "No published version"}{item.publishedVersion && item.publishedVersion.id !== latest?.id ? " · previous version retained during preparation" : ""}</p>
      </li>;
    })}{!page?.items.length && <li>No videos found.</li>}</ul>}
    <div className="flex gap-3"><button disabled={loading || !cursor} onClick={() => { setLoading(true); setCursor(null); }} className="rounded border px-3 py-2 disabled:opacity-40">First page</button>
      <button disabled={loading || !page?.cursor} onClick={() => { setLoading(true); setCursor(page!.cursor); }} className="rounded border px-3 py-2 disabled:opacity-40">Next page</button></div>
  </>;
}
