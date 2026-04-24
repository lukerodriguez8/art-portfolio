#!/usr/bin/env node
/**
 * Scans public/works/ and syncs src/data/works.ts.
 * - Adds new image files automatically
 * - Preserves existing title / year / medium you've already filled in
 * - Reads PNG dimensions from the file header (zero dependencies)
 * - Removes entries whose files no longer exist
 *
 * Usage: node scripts/sync-works.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, extname, basename } from "path";
import { fileURLToPath } from "url";

const root = resolve(fileURLToPath(import.meta.url), "../../");
const worksDir = resolve(root, "public/works");
const worksFile = resolve(root, "src/data/works.ts");

const SUPPORTED = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// ── Read dimensions ──────────────────────────────────────────────────────────

function readPngDimensions(buf) {
  // PNG: sig (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function readJpegDimensions(buf) {
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF markers: 0xC0–0xC3, 0xC5–0xC7, 0xC9–0xCB, 0xCD–0xCF
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segLen;
  }
  return null;
}

function readWebpDimensions(buf) {
  // RIFF....WEBP VP8 / VP8L / VP8X
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return {
      width: (buf.readUInt16LE(26) & 0x3fff) + 1,
      height: (buf.readUInt16LE(28) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  return null;
}

function getDimensions(filepath) {
  const buf = readFileSync(filepath);
  const ext = extname(filepath).toLowerCase();
  if (ext === ".png") return readPngDimensions(buf);
  if (ext === ".jpg" || ext === ".jpeg") return readJpegDimensions(buf);
  if (ext === ".webp") return readWebpDimensions(buf);
  return { width: 1200, height: 900 }; // fallback for gif etc.
}

// ── Parse existing works.ts ──────────────────────────────────────────────────

function parseExistingWorks(source) {
  const map = new Map();
  const blockRe = /\{([^}]+)\}/gs;
  let match;
  while ((match = blockRe.exec(source)) !== null) {
    const block = match[1];
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*["'\`]([^"'\`]*)["'\`]`));
      return m ? m[1] : undefined;
    };
    const getNum = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? parseInt(m[1]) : undefined;
    };
    const filename = get("filename");
    if (!filename) continue;
    map.set(filename, {
      id: get("id") ?? slugify(filename),
      title: get("title") ?? titleFromFilename(filename),
      year: getNum("year") ?? new Date().getFullYear(),
      medium: get("medium"),
      filename,
      width: getNum("width") ?? 0,
      height: getNum("height") ?? 0,
    });
  }
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(filename) {
  return basename(filename, extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleFromFilename(filename) {
  return basename(filename, extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function serialize(work) {
  const lines = [
    `    id: "${work.id}",`,
    `    title: "${work.title}",`,
    `    year: ${work.year},`,
    work.medium ? `    medium: "${work.medium}",` : null,
    `    filename: "${work.filename}",`,
    `    width: ${work.width},`,
    `    height: ${work.height},`,
  ]
    .filter(Boolean)
    .join("\n");
  return `  {\n${lines}\n  }`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = readdirSync(worksDir).filter((f) =>
  SUPPORTED.has(extname(f).toLowerCase())
);

const existingSource = readFileSync(worksFile, "utf8");
const existing = parseExistingWorks(existingSource);

let added = 0;
let updated = 0;
let removed = 0;

const fileSet = new Set(files);

// Remove entries with no matching file
for (const [filename] of existing) {
  if (!fileSet.has(filename)) {
    existing.delete(filename);
    removed++;
  }
}

// Add/update entries for each file
for (const file of files) {
  const dims = getDimensions(resolve(worksDir, file));
  if (!dims) {
    console.warn(`  ⚠ Could not read dimensions for ${file}, skipping`);
    continue;
  }

  if (existing.has(file)) {
    const entry = existing.get(file);
    // Update dimensions if they've changed (e.g. file replaced)
    if (entry.width !== dims.width || entry.height !== dims.height) {
      entry.width = dims.width;
      entry.height = dims.height;
      updated++;
    }
  } else {
    existing.set(file, {
      id: slugify(file),
      title: titleFromFilename(file),
      year: new Date().getFullYear(),
      medium: undefined,
      filename: file,
      width: dims.width,
      height: dims.height,
    });
    added++;
  }
}

// Write updated works.ts
const entries = [...existing.values()].map(serialize).join(",\n");

const output = `export interface Work {
  id: string;
  title: string;
  year: number;
  medium?: string;
  filename: string;
  width: number;
  height: number;
}

export const works: Work[] = [
${entries}
];
`;

writeFileSync(worksFile, output, "utf8");

console.log(
  `✓ Synced ${existing.size} work(s) — +${added} added, ${updated} updated, ${removed} removed`
);
if (added > 0) {
  console.log(
    "  Edit title/year/medium in src/data/works.ts for newly added pieces."
  );
}
