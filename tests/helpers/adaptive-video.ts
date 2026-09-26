import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodingArgs } from "@/lib/video/encoding";
export async function adaptiveFixture(root: string, segment: number, seconds = 42, mode: "audio" | "silent" | "gaps" = "audio") {
  const source = { width: 1280, height: 720, duration: seconds, audio: mode !== "silent" };
  const sourceBytes = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    ...(source.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
    ...(mode === "gaps" ? ["-vf", "select='not(between(t,6,9))'", "-fps_mode", "vfr", "-af", "aselect='not(between(t,12,14))'"] : []),
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-bf", "0", ...(source.audio ? ["-c:a", "aac"] : []),
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"], { maxBuffer: 128 * 1024 ** 2 });
  await writeFile(path.join(root, "source.mp4"), sourceBytes);
  // Synthetic fixture only: use the SAME output pipeline with a local-file
  // protocol override. Production reads decrypted source via its private bridge.
  const args = encodingArgs(source, path.join(root, "source.mp4"), path.join(root, "play.mpd"), segment, 2).map(v => v === "http,tcp" ? "file" : v);
  execFileSync("ffmpeg", args, { stdio: "pipe" });
  const objects: Record<string, Buffer> = {};
  for (const name of await readdir(root)) if (/^(play\.mpd|init-|segment-)/.test(name)) objects[name] = await readFile(path.join(root, name));
  return { source, sourceBytes, objects };
}
