// Small HTTP protocol double, not a claim of AWS interoperability certification.
// The real AWS SDK signs and serializes every request against this endpoint.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
const etag = (data: Buffer) => '"' + createHash("md5").update(data).digest("hex") + '"';
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export async function s3ProtocolServer() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: { method: string; path: string; conditional: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
    requests.push({ method: req.method!, path: url.pathname + url.search, conditional: req.headers["if-none-match"] });
    const send = (status: number, body = "") => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(body); };
    const buffers = []; for await (const chunk of req) buffers.push(Buffer.from(chunk));
    let body = Buffer.concat(buffers);
    if (req.headers["content-encoding"]?.includes("aws-chunked")) {
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < body.length) {
        const end = body.indexOf("\r\n", offset);
        const size = Number.parseInt(body.subarray(offset, end).toString(), 16);
        if (!size) break;
        chunks.push(body.subarray(end + 2, end + 2 + size)); offset = end + 2 + size + 2;
      }
      body = Buffer.concat(chunks);
    }
    if (!key && req.method === "HEAD") return send(200);
    if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") || "";
      const cursor = url.searchParams.get("continuation-token") || "";
      const all = [...objects.keys()].sort().filter(k => k.startsWith(prefix) && k > cursor);
      const keys = all.slice(0, Number(url.searchParams.get("max-keys")));
      return send(200, `<ListBucketResult><IsTruncated>${all.length > keys.length}</IsTruncated>${keys.map(k => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k)!.length}</Size><ETag>${xml(etag(objects.get(k)!))}</ETag></Contents>`).join("")}${all.length > keys.length ? `<NextContinuationToken>${xml(keys.at(-1)!)}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID(); uploads.set(id, { key, parts: new Map() });
      return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const id = url.searchParams.get("uploadId");
    if (id) {
      const upload = uploads.get(id);
      if (!upload || upload.key !== key) return send(404);
      if (req.method === "DELETE") { uploads.delete(id); return send(204); }
      if (req.method === "PUT") {
        upload.parts.set(Number(url.searchParams.get("partNumber")), body);
        res.setHeader("ETag", etag(body)); return send(200);
      }
      if (objects.has(key) && req.headers["if-none-match"] === "*") return send(412);
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(m => Number(m[1]));
      const data = Buffer.concat(numbers.map(n => upload.parts.get(n)!));
      objects.set(key, data); uploads.delete(id);
      return send(200, `<CompleteMultipartUploadResult><ETag>${xml(etag(data))}</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === "PUT") {
      if (objects.has(key) && req.headers["if-none-match"] === "*") return send(412);
      objects.set(key, body); res.setHeader("ETag", etag(body)); return send(200);
    }
    if (req.method === "DELETE") { objects.delete(key); return send(204); }
    const data = objects.get(key); if (!data) return send(404);
    res.setHeader("ETag", etag(data));
    if (req.method === "HEAD") { res.setHeader("Content-Length", data.length); return send(200); }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    const selected = range ? data.subarray(Number(range[1]), Number(range[2]) + 1) : data;
    res.writeHead(range ? 206 : 200, { "Content-Length": selected.length }); res.end(selected);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, objects, uploads, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); }) };
}
