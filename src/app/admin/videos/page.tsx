import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth-helpers";
import { videoEnabled } from "@/lib/video/config";
import VideoLibrary from "./VideoLibrary";
export const dynamic = "force-dynamic";
export default async function VideosPage() {
  await requireOwner(); if (!videoEnabled()) notFound();
  return <div className="mx-auto max-w-5xl space-y-6"><h1 className="text-2xl font-semibold">Video library</h1><VideoLibrary /></div>;
}
