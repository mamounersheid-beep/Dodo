/**
 * Public object-storage URL for a stored objectKey.
 * 10.2 names this representation as `primaryImageUrl` / `images[].url`.
 * Catalog list/PDP execute of those fields is not this slice.
 * Uses existing S3_* env from .env.example (path-style MinIO default).
 */
export function toPublicObjectUrl(objectKey: string): string {
  const endpoint = (process.env.S3_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = process.env.S3_BUCKET ?? "dodo";
  const key = objectKey.replace(/^\/+/, "");
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== "false";
  if (forcePathStyle) {
    return `${endpoint}/${bucket}/${key}`;
  }
  const u = new URL(endpoint);
  return `${u.protocol}//${bucket}.${u.host}/${key}`;
}
