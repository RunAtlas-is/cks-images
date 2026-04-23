#!/usr/bin/env bun
// Publish the contents of ./dist to the bucket under cks/.
// Generic: every file in DIST_DIR uploads with a content-type inferred from
// extension. No logic about what the files mean.
//
// Env:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, BUCKET_NAME
//     required
//   DIST_DIR                  directory to upload (default: ./dist)
//   BUCKET_PREFIX             key prefix inside the bucket (default: cks/)

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env: ${k}`);
  return v;
};

const AWS_ACCESS_KEY_ID = need("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = need("AWS_SECRET_ACCESS_KEY");
const AWS_ENDPOINT_URL = need("AWS_ENDPOINT_URL");
const BUCKET = need("BUCKET_NAME");

const HERE = dirname(new URL(import.meta.url).pathname);
const DIST = process.env.DIST_DIR ?? join(HERE, "dist");
const PREFIX = process.env.BUCKET_PREFIX ?? "cks/";

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: AWS_ENDPOINT_URL,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".asc": "application/pgp-signature",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  const ct = contentTypes[ext];
  if (ct) return ct;
  console.warn(`[publish] no content-type mapping for ${ext}; falling back to application/octet-stream`);
  return "application/octet-stream";
}

// Walk dist/ without following symlinks — a symlink loop inside the tree
// would otherwise produce infinite recursion.
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

async function main() {
  let count = 0;
  for (const path of walk(DIST)) {
    const rel = relative(DIST, path);
    const key = PREFIX + rel.replaceAll("\\", "/");
    const body = readFileSync(path);
    const ct = contentTypeFor(path);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: body,
          ContentType: ct,
          // Short cache for the index page; assets are content-addressable
          // via their bytes, so a longer cache is safe.
          CacheControl: rel === "index.html" ? "max-age=60" : "max-age=3600",
        }),
      );
    } catch (err) {
      throw new Error(`[publish] put-object failed on ${key}: ${err}`);
    }
    count++;
    console.log(`[publish] ${rel} -> s3://${BUCKET}/${key} (${body.length} bytes, ${ct})`);
  }
  console.log(`[publish] ${count} file(s) uploaded from ${DIST}`);
}

await main();
