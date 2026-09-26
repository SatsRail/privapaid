import { spawn } from "node:child_process";
import { IngestionError } from "./ingestion-errors";
export async function mediaProcess(binary: string, args: string[], options: { signal: AbortSignal; input?: AsyncIterable<Buffer>; line?: (line: string) => void; maxOutput?: number } ) {
  options.signal.throwIfAborted();
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "production", PATH: process.env.PATH, LANG: "C", AV_LOG_FORCE_NOCOLOR: "1" }, windowsHide: true });
  let output = "", pending = "", failure: unknown;
  const kill = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", kill, { once: true });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", () => { failure = new IngestionError("PROCESSOR_UNAVAILABLE", 503, true); reject(failure); });
    child.stdout.on("data", chunk => {
      try {
        if (options.line) {
          pending += chunk.toString(); let end: number;
          while ((end = pending.indexOf("\n")) >= 0) { options.line(pending.slice(0, end)); pending = pending.slice(end + 1); }
          if (pending.length > 4096) throw new IngestionError("OUTPUT_INVALID");
        } else {
          output += chunk.toString(); if (output.length > (options.maxOutput || 65536)) throw new IngestionError("OUTPUT_INVALID");
        }
      } catch (err) { failure = err; kill(); }
    });
    child.stderr.resume(); // Never log FFmpeg's input URLs, metadata or diagnostics.
    child.once("close", code => {
      if (options.signal.aborted) return reject(options.signal.reason);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new IngestionError("INVALID_VIDEO", 422));
      try { if (pending && options.line) options.line(pending); resolve(); } catch (err) { reject(err); }
    });
  });
  // Observe completion immediately, including spawn failures while feeding stdin.
  const feeding = (async () => {
    try {
      if (options.input) for await (const data of options.input) {
        try {
          options.signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve()));
        } finally { data.fill(0); }
      }
      child.stdin.end();
    } catch (err) { failure ||= err; kill(); }
  })();
  child.stdin.on("error", () => {});
  try { await Promise.all([closed, feeding]); return output; }
  finally { options.signal.removeEventListener("abort", kill); kill(); child.stdin.destroy(); await Promise.allSettled([closed, feeding]); }
}
export const safeInputArgs = ["-protocol_whitelist", "http,tcp", "-rw_timeout", "30000000", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-probesize", "5242880", "-analyzeduration", "10000000", "-f", "mov"];
