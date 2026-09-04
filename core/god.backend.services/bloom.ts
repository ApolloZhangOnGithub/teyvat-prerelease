// bloom.ts — 零依赖布隆过滤器基础组件（备件，暂未接入任何生产路径）
// 背景：researcher-bloom-filter-01 对 teyvat 同步/记忆场景的调研结论（ISSUE 075 关联）：
//   - 同步扫描：shadow manifest 已是精确 hash 映射，BF 答不了"hash 是多少"，增量用 mtime+size 而非 BF；
//   - BF 甜点在协议层（服务端 manifest BF 预筛，O(N)→O(变更)）与消息投递幂等（内存挡重复 ID）；
//   - 本文件作为基础件备好，规模增长 / 协议改造时直接复用，当前不 import 到任何生产代码。
// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI

// ── 双哈希派生 k 个位置（Double Hashing，避免 k 次独立哈希的开销）──
// 用 FNV-1a 变体得到两个独立 32 位哈希 h1/h2，第 i 个位置 = (h1 + i*h2) mod m
function fnv1a(str: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashPair(str: string, seed: number): [number, number] {
  const h1 = fnv1a(str, seed) >>> 0;
  const h2 = (fnv1a(str, seed ^ 0x9e3779b9) | 1) >>> 0; // 奇数（步长与 2 的幂 m 互质）；>>>0 转无符号防负数
  return [h1, h2];
}

export interface BloomOptions {
  /** 位数组大小（bit 数） */
  m: number;
  /** 哈希函数个数 */
  k: number;
  /** 派生哈希的随机种子（不同实例用不同种子避免结构性冲突） */
  seed?: number;
}

/**
 * 经典 Bloom Filter：add/query。
 * - 无假阴性（说"不在"必不在）；可能有假阳性（p ≈ (1-e^(-kn/m))^k）。
 * - 空间：m bits 固定，与元素数无关（这是相对 Set/Map 的核心优势）。
 */
export class BloomFilter {
  private bits: Uint8Array;
  private readonly m: number;
  private readonly k: number;
  private readonly seed: number;
  private _count = 0;

  constructor(opts: BloomOptions) {
    this.m = opts.m;
    this.k = opts.k;
    this.seed = opts.seed ?? 0;
    this.bits = new Uint8Array(Math.ceil(opts.m / 8));
  }

  private positions(x: string): number[] {
    const [h1, h2] = hashPair(x, this.seed);
    const pos: number[] = [];
    for (let i = 0; i < this.k; i++) {
      pos.push(((h1 + i * h2) >>> 0) % this.m); // i*h2 双精度精确（<2^53），>>>0 防 32 位溢出
    }
    return pos;
  }

  private getBit(i: number): boolean {
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  }

  private setBit(i: number): void {
    this.bits[i >> 3] |= 1 << (i & 7);
  }

  add(x: string): void {
    for (const i of this.positions(x)) this.setBit(i);
    this._count++;
  }

  /** true = 可能存在（含假阳性）；false = 一定不存在 */
  has(x: string): boolean {
    for (const i of this.positions(x)) {
      if (!this.getBit(i)) return false;
    }
    return true;
  }

  get count(): number {
    return this._count;
  }

  /** 序列化（持久化到磁盘用，如 RuntimeCache） */
  toJSON(): { m: number; k: number; seed: number; bits: number[] } {
    return { m: this.m, k: this.k, seed: this.seed, bits: Array.from(this.bits) };
  }

  static fromJSON(data: { m: number; k: number; seed: number; bits: number[] }): BloomFilter {
    const bf = new BloomFilter({ m: data.m, k: data.k, seed: data.seed });
    bf.bits = Uint8Array.from(data.bits);
    return bf;
  }
}

/**
 * Counting Bloom Filter（CBF）：计数器替代位，支持 remove（删除）。
 * 适合滑动窗口去重：窗口内签名 add，滑出窗口 remove。
 * 注意：计数器可能溢出（本实现 Uint8 上限 255，k 个 hash 位置同一计数器最多累加 k 次/元素，
 * 窗口内同一元素重复 add 超过 ~255/k 次会溢出），高频场景请换 Uint16Array（改 counters 类型）。
 */
export class CountingBloomFilter {
  private counters: Uint8Array;
  private readonly m: number;
  private readonly k: number;
  private readonly seed: number;

  constructor(opts: BloomOptions) {
    this.m = opts.m;
    this.k = opts.k;
    this.seed = opts.seed ?? 0;
    this.counters = new Uint8Array(opts.m);
  }

  private positions(x: string): number[] {
    const [h1, h2] = hashPair(x, this.seed);
    const pos: number[] = [];
    for (let i = 0; i < this.k; i++) {
      pos.push(((h1 + i * h2) >>> 0) % this.m);
    }
    return pos;
  }

  add(x: string): void {
    for (const i of this.positions(x)) {
      if (this.counters[i] < 255) this.counters[i]++;
    }
  }

  remove(x: string): void {
    for (const i of this.positions(x)) {
      if (this.counters[i] > 0) this.counters[i]--;
    }
  }

  has(x: string): boolean {
    for (const i of this.positions(x)) {
      if (this.counters[i] === 0) return false;
    }
    return true;
  }

  toJSON(): { m: number; k: number; seed: number; counters: number[] } {
    return { m: this.m, k: this.k, seed: this.seed, counters: Array.from(this.counters) };
  }

  static fromJSON(data: { m: number; k: number; seed: number; counters: number[] }): CountingBloomFilter {
    const cbf = new CountingBloomFilter({ m: data.m, k: data.k, seed: data.seed });
    cbf.counters = Uint8Array.from(data.counters);
    return cbf;
  }
}

/**
 * 滑动窗口 CBF：定长窗口内去重。
 * 用法：每条新签名先 has()，命中则跳过；未命中则 add() 并 push 进窗口，
 * 窗口满时 shift() 最旧一条并 remove()。窗口大小固定 → CBF 内存恒定。
 * 适合 memory.ts 的全局自噬去重升级（替代仅连续去重的 sig===lastSig）。
 */
export class SlidingWindowCBF {
  private cbf: CountingBloomFilter;
  private window: string[] = [];
  private readonly capacity: number;

  constructor(capacity: number, opts: BloomOptions) {
    this.capacity = capacity;
    this.cbf = new CountingBloomFilter(opts);
  }

  /** true = 窗口内出现过（含假阳性）；false = 一定没出现过 */
  seen(x: string): boolean {
    return this.cbf.has(x);
  }

  /** 记录并推进窗口：返回是否是新元素（false = 已在窗口内） */
  push(x: string): boolean {
    if (this.cbf.has(x)) return false;
    this.cbf.add(x);
    this.window.push(x);
    if (this.window.length > this.capacity) {
      const oldest = this.window.shift();
      if (oldest !== undefined) this.cbf.remove(oldest);
    }
    return true;
  }

  get size(): number {
    return this.window.length;
  }

  toJSON() {
    return { capacity: this.capacity, window: this.window, cbf: this.cbf.toJSON() };
  }

  static fromJSON(data: { capacity: number; window: string[]; cbf: { m: number; k: number; seed: number; counters: number[] } }): SlidingWindowCBF {
    const sw = new SlidingWindowCBF(data.capacity, { m: data.cbf.m, k: data.cbf.k, seed: data.cbf.seed });
    sw.window = data.window;
    sw.cbf = CountingBloomFilter.fromJSON(data.cbf);
    return sw;
  }
}
