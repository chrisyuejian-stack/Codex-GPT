export class LocalR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    this.objects.set(key, String(value));
    return { key };
  }
  async get(key) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    // 与线上 R2 一致：传了 cursor 就必须是上一页给的有效值，空字符串会被拒绝（10023）。
    if (cursor !== undefined && !/^\d+$/.test(String(cursor)))
      throw new Error("list: Continuation token is not valid. (10023)");
    const keys = [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort(),
      start = cursor ? Number(cursor) : 0,
      page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({ key })),
      truncated: start + limit < keys.length,
      cursor: String(start + limit),
    };
  }
}
