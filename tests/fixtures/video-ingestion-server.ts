import { createServer } from "node:http";
import { Readable } from "node:stream";
import { POST } from "../../src/app/api/admin/video-pipeline/uploads/route";
import { GET } from "../../src/app/api/admin/video-pipeline/uploads/[id]/route";
import { PUT } from "../../src/app/api/admin/video-pipeline/uploads/[id]/parts/route";
import { POST as complete } from "../../src/app/api/admin/video-pipeline/uploads/[id]/complete/route";
import { POST as resume } from "../../src/app/api/admin/video-pipeline/uploads/[id]/resume/route";
// Real route handlers over HTTP, with a test-only owner alias. Unit tests cover
// the real authentication/CSRF boundary. Binds loopback on an ephemeral port.
let origin = "";
const server = createServer(async (req, res) => {
  try {
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers as Record<string, string>,
      ...(req.method !== "GET" ? { body: Readable.toWeb(req), duplex: "half" } : {}) } as RequestInit);
    const match = /^\/uploads\/([a-f0-9-]+)(?:\/(parts|complete|resume))?$/.exec(req.url!);
    const context = { params: Promise.resolve({ id: match?.[1] || "" }) };
    const response = req.url === "/uploads" ? await POST(request) : match?.[2] === "parts" ? await PUT(request, context)
      : match?.[2] === "complete" ? await complete(request, context) : match?.[2] === "resume" ? await resume(request, context) : await GET(request, context);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch { res.writeHead(500).end(); }
});
server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.AUTH_URL = origin; process.env.NEXTAUTH_URL = origin;
  process.send?.({ origin });
});
process.on("message", () => process.send?.({ maxRSSKiB: process.resourceUsage().maxRSS }));
