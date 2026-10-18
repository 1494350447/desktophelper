import { closeSync, openSync, readSync, statSync } from "node:fs";

const SAFE_ASCII = /^[ -~]+$/;
const WINDOWS_INVALID = "<>:\"|?*" + String.fromCharCode(92);

export function isSafeZipEntryName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (!SAFE_ASCII.test(name)) return false;
  for (const ch of WINDOWS_INVALID) {
    if (name.includes(ch)) return false;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  return true;
}

export function listZipEntryNames(file) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const tailLength = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found");

    const total = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const central = Buffer.alloc(centralSize);
    readSync(fd, central, 0, centralSize, centralOffset);

    const names = [];
    let offset = 0;
    for (let i = 0; i < total; i += 1) {
      if (central.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("invalid ZIP central directory entry at " + offset);
      }
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      names.push(name);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

export function assertSafeZipEntries(file) {
  const unsafe = listZipEntryNames(file).filter((name) => !isSafeZipEntryName(name));
  if (unsafe.length > 0) {
    const newline = String.fromCharCode(10);
    throw new Error(
      "ZIP contains entry names that are not safe on Windows:" +
        newline +
        unsafe.map((name) => "  " + JSON.stringify(name)).join(newline),
    );
  }
}
