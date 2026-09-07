import { Injectable, Logger } from "@nestjs/common";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { InvoicePdfObjectStorage } from "./invoice-pdf.port";

/**
 * Private Invoice PDF objects on existing S3-compatible stack.
 * Does NOT use toPublicObjectUrl / ProductImage Media semantics.
 */
@Injectable()
export class S3InvoicePdfObjectStorage implements InvoicePdfObjectStorage {
  private readonly logger = new Logger(S3InvoicePdfObjectStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = (process.env.S3_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
    const region = process.env.S3_REGION ?? "auto";
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== "false";
    this.bucket = process.env.S3_BUCKET ?? "dodo";
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "dodo",
        secretAccessKey: process.env.S3_SECRET_KEY ?? "dodo_secret_change",
      },
    });
  }

  async putPdfObject(objectKey: string, body: Buffer): Promise<void> {
    const key = objectKey.replace(/^\/+/, "");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/pdf",
        // Private object — no public ACL
      }),
    );
    if (process.env.NODE_ENV === "development") {
      this.logger.debug(`put private invoice PDF key=${key} bytes=${body.length}`);
    }
  }
}

/** Test / in-process storage — no network. */
export class InMemoryInvoicePdfObjectStorage implements InvoicePdfObjectStorage {
  readonly objects = new Map<string, Buffer>();
  failNextPut = false;
  putCount = 0;

  async putPdfObject(objectKey: string, body: Buffer): Promise<void> {
    this.putCount += 1;
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("storage_put_failed");
    }
    this.objects.set(objectKey.replace(/^\/+/, ""), Buffer.from(body));
  }
}
