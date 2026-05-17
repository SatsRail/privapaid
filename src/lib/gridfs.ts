import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import { connectDB } from "@/lib/mongodb";

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

let bucket: GridFSBucket | null = null;
let encryptedBucket: GridFSBucket | null = null;

async function getDb() {
  const conn = await connectDB();
  let db = conn.connection.db ?? mongoose.connection.db;
  if (!db) {
    await mongoose.connection.asPromise();
    db = mongoose.connection.db;
    if (!db) throw new Error("MongoDB connection not ready");
  }
  return db;
}

export async function getGridFSBucket(): Promise<GridFSBucket> {
  if (bucket) return bucket;
  const db = await getDb();
  bucket = new GridFSBucket(db, { bucketName: "images" });
  return bucket;
}

/**
 * Separate bucket for encrypted photo content. Distinct from the "images"
 * bucket (which holds plaintext thumbnails / preview images) so it's obvious
 * at the storage layer what is encrypted vs not.
 */
export async function getEncryptedPhotosBucket(): Promise<GridFSBucket> {
  if (encryptedBucket) return encryptedBucket;
  const db = await getDb();
  encryptedBucket = new GridFSBucket(db, { bucketName: "encrypted_photos" });
  return encryptedBucket;
}
