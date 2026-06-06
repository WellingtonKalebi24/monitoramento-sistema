import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const currentDir = dirname(fileURLToPath(import.meta.url));
export const uploadsDir = join(currentDir, "..", "uploads");
export const facesDir = join(uploadsDir, "faces");

export async function ensureUploadDirs() {
  await mkdir(facesDir, { recursive: true });
}

export async function saveFaceDataUrl(imageDataUrl: string) {
  const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new Error("INVALID_IMAGE");
  }

  const [, mimeType, base64] = match;
  const extension = mimeType.includes("png") ? "png" : "jpg";
  const filename = `${randomUUID()}.${extension}`;
  const filePath = join(facesDir, filename);
  await writeFile(filePath, Buffer.from(base64, "base64"));

  return {
    filePath,
    imageUrl: `/uploads/faces/${filename}`
  };
}

export async function removeStoredFace(imageUrl: string) {
  const pathname = new URL(imageUrl, "http://local").pathname;
  if (!pathname.startsWith("/uploads/faces/")) {
    return;
  }

  const filename = basename(pathname);
  try {
    await unlink(join(facesDir, filename));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
