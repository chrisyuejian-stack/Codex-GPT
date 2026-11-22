import { createHash } from "node:crypto";

// Cloudflare R2 Workers API & limits reference:
// - https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
// - https://developers.cloudflare.com/r2/platform/limits/
export const R2_LIMITS = {
  MAX_KEY_BYTES: 1024,
  MAX_METADATA_BYTES: 8192,
  MAX_DELETE_KEYS: 1000,
  MAX_LIST_LIMIT: 1000,
};

function assertKey(key) {
  if (typeof key !== "string" || !key.length)
    throw new Error("R2 invalid object key: key must be a non-empty string");
  if (Buffer.byteLength(key) > R2_LIMITS.MAX_KEY_BYTES)
    throw new Error("R2_KEY_TOO_LONG: Object key exceeds 1024 bytes");
}

function assertMetadataSize(httpMetadata, customMetadata) {
  const bytes =
    Buffer.byteLength(JSON.stringify(httpMetadata || {})) +
    Buffer.byteLength(JSON.stringify(customMetadata || {}));
  if (bytes > R2_LIMITS.MAX_METADATA_BYTES)
    throw new Error("R2_METADATA_TOO_BIG: Object metadata exceeds 8192 bytes");
}

async function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (typeof value.arrayBuffer === "function")
    return new Uint8Array(await value.arrayBuffer());
  if (typeof value.getReader === "function") {
    const reader = value.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      chunks.push(u8);
      total += u8.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  return new TextEncoder().encode(String(value));
}

function matchesOnlyIf(meta, onlyIf) {
  if (!onlyIf || typeof onlyIf !== "object") return true;
  if (onlyIf.etagMatches !== undefined) {
    const target = String(onlyIf.etagMatches).replace(/^"|"$/g, "");
    if (!meta || meta.etag !== target) return false;
  }
  if (onlyIf.etagDoesNotMatch !== undefined) {
    const target = String(onlyIf.etagDoesNotMatch).replace(/^"|"$/g, "");
    if (meta && (target === "*" || meta.etag === target)) return false;
  }
  if (onlyIf.uploadedBefore instanceof Date) {
    if (!meta || !(meta.uploaded < onlyIf.uploadedBefore)) return false;
  }
  if (onlyIf.uploadedAfter instanceof Date) {
    if (!meta || !(meta.uploaded > onlyIf.uploadedAfter)) return false;
  }
  return true;
}

function sliceRange(bytes, range) {
  if (!range) return { slice: bytes, range: undefined };
  const total = bytes.byteLength;
  if (typeof range.suffix === "number") {
    if (range.suffix < 0 || !Number.isInteger(range.suffix))
      throw new Error("R2_INVALID_RANGE: suffix must be a non-negative integer");
    const len = Math.min(range.suffix, total);
    const offset = total - len;
    return {
      slice: bytes.subarray(offset, total),
      range: { offset, length: len },
    };
  }
  const offset = range.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("R2_INVALID_RANGE: offset must be a non-negative integer");
  const length =
    range.length !== undefined
      ? Math.min(range.length, Math.max(0, total - offset))
      : Math.max(0, total - offset);
  if (range.length !== undefined && (!Number.isInteger(range.length) || range.length < 0))
    throw new Error("R2_INVALID_RANGE: length must be a non-negative integer");
  return {
    slice: bytes.subarray(offset, offset + length),
    range: { offset, length },
  };
}

function makeObjectMeta(key, meta, { includeHttp = true, includeCustom = true } = {}) {
  const out = {
    key,
    version: meta.version,
    size: meta.size,
    etag: meta.etag,
    httpEtag: meta.httpEtag,
    uploaded: meta.uploaded,
  };
  if (includeHttp) out.httpMetadata = { ...meta.httpMetadata };
  if (includeCustom) out.customMetadata = { ...meta.customMetadata };
  return out;
}

export class LocalR2 {
  constructor() {
    this.objects = new Map();
    this.meta = new Map();
  }
  _entry(key) {
    if (!this.objects.has(key)) return null;
    let m = this.meta.get(key);
    if (!m) {
      const raw = this.objects.get(key);
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw));
      const etag = createHash("md5").update(bytes).digest("hex");
      m = {
        bytes,
        size: bytes.byteLength,
        etag,
        httpEtag: '"' + etag + '"',
        version: etag.slice(0, 16),
        uploaded: new Date(),
        httpMetadata: {},
        customMetadata: {},
      };
      this.meta.set(key, m);
    }
    return m;
  }
  async put(key, value, options = {}) {
    assertKey(key);
    const httpMetadata = options?.httpMetadata ? { ...options.httpMetadata } : {};
    const customMetadata = options?.customMetadata ? { ...options.customMetadata } : {};
    assertMetadataSize(httpMetadata, customMetadata);
    if (options?.onlyIf && !matchesOnlyIf(this._entry(key), options.onlyIf))
      return null;
    const bytes = await toBytes(value);
    const etag = createHash("md5").update(bytes).digest("hex");
    const entry = {
      bytes,
      size: bytes.byteLength,
      etag,
      httpEtag: '"' + etag + '"',
      version: etag.slice(0, 16),
      uploaded: new Date(),
      httpMetadata,
      customMetadata,
    };
    this.objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(bytes));
    this.meta.set(key, entry);
    return makeObjectMeta(key, entry);
  }
  async head(key) {
    assertKey(key);
    const entry = this._entry(key);
    if (!entry) return null;
    return makeObjectMeta(key, entry);
  }
  async get(key, options = {}) {
    assertKey(key);
    const entry = this._entry(key);
    if (!entry) return null;
    if (options?.onlyIf && !matchesOnlyIf(entry, options.onlyIf))
      return makeObjectMeta(key, entry);
    const { slice, range } = sliceRange(entry.bytes, options?.range);
    const copy = new Uint8Array(slice);
    return {
      ...makeObjectMeta(key, entry),
      ...(range ? { range } : {}),
      bodyUsed: false,
      get body() {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(copy);
            controller.close();
          },
        });
      },
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
      },
      async bytes() {
        return new Uint8Array(copy);
      },
      async text() {
        return new TextDecoder().decode(copy);
      },
      async json() {
        return JSON.parse(new TextDecoder().decode(copy));
      },
      async blob() {
        return new Blob([copy], { type: entry.httpMetadata.contentType || "" });
      },
    };
  }
  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length > R2_LIMITS.MAX_DELETE_KEYS)
      throw new Error("R2_DELETE_TOO_MANY_KEYS: delete() accepts at most 1000 keys per call");
    for (const key of list) {
      assertKey(key);
      this.objects.delete(key);
      this.meta.delete(key);
    }
  }
  async list({ prefix = "", cursor, limit = 1000, delimiter, include = [] } = {}) {
    // 与线上 R2 一致：传了 cursor 就必须是上一页给的有效值，空字符串会被拒绝（10023）。
    if (cursor !== undefined && !/^\d+$/.test(String(cursor)))
      throw new Error("list: Continuation token is not valid. (10023)");
    if (!Number.isInteger(limit) || limit < 1 || limit > R2_LIMITS.MAX_LIST_LIMIT)
      throw new Error("R2_INVALID_LIMIT: list() limit must be an integer between 1 and 1000");
    const matching = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const items = [];
    const seenPrefixes = new Set();
    for (const key of matching) {
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          const cp = prefix + rest.slice(0, idx + delimiter.length);
          if (!seenPrefixes.has(cp)) {
            seenPrefixes.add(cp);
            items.push({ kind: "prefix", value: cp });
          }
          continue;
        }
      }
      items.push({ kind: "object", value: key });
    }
    const start = cursor ? Number(cursor) : 0;
    const page = items.slice(start, start + limit);
    const truncated = start + limit < items.length;
    const includeHttp = include.includes("httpMetadata");
    const includeCustom = include.includes("customMetadata");
    const objects = [];
    const delimitedPrefixes = [];
    for (const item of page) {
      if (item.kind === "prefix") delimitedPrefixes.push(item.value);
      else
        objects.push(
          makeObjectMeta(item.value, this._entry(item.value), {
            includeHttp,
            includeCustom,
          }),
        );
    }
    return {
      objects,
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
      delimitedPrefixes,
    };
  }
}
