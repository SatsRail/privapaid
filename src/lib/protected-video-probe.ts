import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { VideoError } from "@/lib/protected-video-errors";

/** Probe decrypted bytes through stdin; never create a plaintext temporary file. */
export async function validateVideo(body: ReadableStream<Uint8Array>): Promise<void> {
  const child = spawn(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-protocol_whitelist", "pipe", "-show_entries",
    "stream=codec_type,codec_name:format=duration,format_name", "-of", "json", "pipe:0",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new VideoError("validator_unavailable")));
    child.stdout.on("data", data => {
      output += data.toString();
      if (output.length > 65_536) child.kill("SIGKILL");
    });
    child.once("close", code => {
      if (timedOut) return reject(new VideoError("validation_timeout"));
      if (code !== 0) return reject(new VideoError("invalid_video"));
      resolve();
    });
  });
  // Always observe both promises, including missing-executable and early-exit cases.
  const streamed = pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), child.stdin).catch(error => error);
  try {
    await completed;
    const streamError = await streamed;
    if (streamError && streamError.code !== "EPIPE" && streamError.code !== "ERR_STREAM_PREMATURE_CLOSE") throw new VideoError("invalid_video");
    const result = JSON.parse(output);
    const streams: { codec_type: string; codec_name: string }[] = result.streams ?? [];
    const videos = streams.filter(s => s.codec_type === "video");
    const audio = streams.filter(s => s.codec_type === "audio");
    if (videos.length !== 1 || videos[0].codec_name !== "h264" || audio.length > 1 || audio.some(s => s.codec_name !== "aac") || streams.length !== videos.length + audio.length || !Number.isFinite(Number(result.format?.duration)) || Number(result.format.duration) <= 0 || !String(result.format?.format_name).split(",").includes("mp4")) {
      throw new VideoError("invalid_video");
    }
  } catch (error) {
    child.kill("SIGKILL");
    if (error instanceof VideoError) throw error;
    throw new VideoError("invalid_video");
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    await streamed;
  }
}
