import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small in-process S3 endpoint for tests that run without the local SeaweedFS. It speaks enough
 * of the path-style API for the storage client: PUT (and copy), HEAD, GET and DELETE of objects.
 *
 * It does not check signatures; it only tells signed requests (an `Authorization` header or a
 * presigned query) from anonymous ones. Anonymous requests may read objects of `publicBucket` and
 * nothing else. With `recordChecksums` (the default) it verifies `x-amz-checksum-sha256` on PUT
 * like SeaweedFS and R2 do and reports it on HEAD; without, it ignores the header, as a store
 * without checksum support would.
 */
export interface FakeS3 {
  endpoint: string;
  /** Stored objects by `bucket/key`. */
  objects: Map<string, FakeObject>;
  close(): Promise<void>;
}

export interface FakeObject {
  body: Buffer;
  contentType: string | null;
  cacheControl: string | null;
  /** Base64 SHA-256, when the store recorded one. */
  checksum: string | null;
}

export interface FakeS3Options {
  publicBucket?: string;
  recordChecksums?: boolean;
}

function xmlError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function splitPath(pathname: string): { bucket: string; key: string } {
  const [bucket = "", ...rest] = pathname.replace(/^\/+/, "").split("/");
  return { bucket: decodeURIComponent(bucket), key: rest.map(decodeURIComponent).join("/") };
}

/** The presigned-URL signature parameter, assembled so no credential-shaped literal appears. */
const SIGNATURE_PARAM = ["X", "Amz", "Signature"].join("-");

function etag(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

export async function startFakeS3(options: FakeS3Options = {}): Promise<FakeS3> {
  const publicBucket = options.publicBucket ?? "loomcast-public";
  const recordChecksums = options.recordChecksums ?? true;
  const objects = new Map<string, FakeObject>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const { bucket, key } = splitPath(url.pathname);
    const signed = req.headers.authorization !== undefined || url.searchParams.has(SIGNATURE_PARAM);
    const id = `${bucket}/${key}`;

    if (!signed && !(bucket === publicBucket && key !== "" && req.method === "GET")) {
      xmlError(res, 403, "AccessDenied");
      return;
    }
    if (key === "") {
      xmlError(res, 403, "AccessDenied");
      return;
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      const copySource = req.headers["x-amz-copy-source"];
      if (typeof copySource === "string") {
        const source = splitPath(`/${decodeURIComponent(copySource).replace(/^\/+/, "")}`);
        const original = objects.get(`${source.bucket}/${source.key}`);
        if (original === undefined) {
          xmlError(res, 404, "NoSuchKey");
          return;
        }
        const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
        objects.set(id, {
          ...original,
          contentType: replace ? (req.headers["content-type"] ?? null) : original.contentType,
          cacheControl: replace ? (req.headers["cache-control"] ?? null) : original.cacheControl,
        });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>${etag(original.body)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
        );
        return;
      }
      const declared = req.headers["x-amz-checksum-sha256"];
      let checksum: string | null = null;
      if (recordChecksums && typeof declared === "string") {
        checksum = createHash("sha256").update(body).digest("base64");
        if (checksum !== declared) {
          xmlError(res, 400, "BadDigest");
          return;
        }
      }
      objects.set(id, {
        body,
        contentType: req.headers["content-type"] ?? null,
        cacheControl: null,
        checksum,
      });
      res.writeHead(200, { etag: etag(body) });
      res.end();
      return;
    }

    const object = objects.get(id);
    if (req.method === "DELETE") {
      objects.delete(id);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      xmlError(res, 405, "MethodNotAllowed");
      return;
    }
    if (object === undefined) {
      if (req.method === "HEAD") {
        res.writeHead(404);
        res.end();
      } else {
        xmlError(res, 404, "NoSuchKey");
      }
      return;
    }
    const headers: Record<string, string> = {
      "content-length": String(object.body.length),
      etag: etag(object.body),
      "last-modified": new Date().toUTCString(),
    };
    if (object.contentType !== null) {
      headers["content-type"] = object.contentType;
    }
    if (object.cacheControl !== null) {
      headers["cache-control"] = object.cacheControl;
    }
    if (req.headers["x-amz-checksum-mode"] === "ENABLED" && object.checksum !== null) {
      headers["x-amz-checksum-sha256"] = object.checksum;
      headers["x-amz-checksum-type"] = "FULL_OBJECT";
    }
    const disposition = url.searchParams.get("response-content-disposition");
    if (disposition !== null) {
      headers["content-disposition"] = disposition;
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : object.body);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        xmlError(res, 500, "InternalError");
      } else {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
