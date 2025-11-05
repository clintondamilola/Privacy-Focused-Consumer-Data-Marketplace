import { describe, it, expect, beforeEach } from "vitest";

const ERR_UNAUTHORIZED = 100;
const ERR_BATCH_NOT_FOUND = 101;
const ERR_BATCH_CLOSED = 102;
const ERR_INVALID_K = 103;
const ERR_INSUFFICIENT_DATA = 104;
const ERR_INVALID_VALUE = 105;
const ERR_INVALID_CATEGORY = 106;
const ERR_AGGREGATION_FAILED = 107;
const ERR_BATCH_EXISTS = 108;
const ERR_INVALID_TIMESTAMP = 109;
const ERR_ZERO_CONTRIBUTION = 110;

interface Batch {
  category: string;
  kAnonymity: number;
  status: "open" | "closed";
  submissionCount: number;
  sumValues: number;
  sumSquares: number;
  minValue: number | null;
  maxValue: number | null;
  createdAt: number;
  closedAt: number | null;
}

interface Submission {
  value: number;
  category: string;
  timestamp: number;
}

interface Insight {
  mean: number;
  variance: number;
  stdDev: number;
  count: number;
  minVal: number;
  maxVal: number;
  generatedAt: number;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class AggregationEngineMock {
  state: {
    nextBatchId: number;
    minKAnonymity: number;
    aggregationFee: number;
    batches: Map<number, Batch>;
    submissions: Map<string, Submission>;
    insights: Map<number, Insight>;
  } = {
    nextBatchId: 0,
    minKAnonymity: 5,
    aggregationFee: 1000,
    batches: new Map(),
    submissions: new Map(),
    insights: new Map(),
  };

  blockHeight: number = 100;
  caller: string = "ST1USER";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextBatchId: 0,
      minKAnonymity: 5,
      aggregationFee: 1000,
      batches: new Map(),
      submissions: new Map(),
      insights: new Map(),
    };
    this.blockHeight = 100;
    this.caller = "ST1USER";
  }

  private key(batchId: number, user: string): string {
    return `${batchId}-${user}`;
  }

  createBatch(category: string, kAnonymity: number): Result<number> {
    const batchId = this.state.nextBatchId;
    if (this.state.batches.has(batchId))
      return { ok: false, value: ERR_BATCH_EXISTS };
    if (!["app-usage", "screen-time", "location", "health"].includes(category))
      return { ok: false, value: ERR_INVALID_CATEGORY };
    if (kAnonymity < this.state.minKAnonymity || kAnonymity > 1000)
      return { ok: false, value: ERR_INVALID_K };

    this.state.batches.set(batchId, {
      category,
      kAnonymity,
      status: "open",
      submissionCount: 0,
      sumValues: 0,
      sumSquares: 0,
      minValue: null,
      maxValue: null,
      createdAt: this.blockHeight,
      closedAt: null,
    });
    this.state.nextBatchId++;
    return { ok: true, value: batchId };
  }

  submitData(
    batchId: number,
    value: number,
    category: string
  ): Result<boolean> {
    const batch = this.state.batches.get(batchId);
    if (!batch) return { ok: false, value: ERR_BATCH_NOT_FOUND };
    if (batch.status !== "open") return { ok: false, value: ERR_BATCH_CLOSED };
    if (batch.category !== category)
      return { ok: false, value: ERR_INVALID_CATEGORY };
    if (value <= 0) return { ok: false, value: ERR_ZERO_CONTRIBUTION };

    const key = this.key(batchId, this.caller);
    if (this.state.submissions.has(key))
      return { ok: false, value: ERR_UNAUTHORIZED };

    const newCount = batch.submissionCount + 1;
    const newSum = batch.sumValues + value;
    const newSq = batch.sumSquares + value * value;
    const newMin =
      batch.minValue === null ? value : Math.min(value, batch.minValue);
    const newMax =
      batch.maxValue === null ? value : Math.max(value, batch.maxValue);

    this.state.submissions.set(key, {
      value,
      category,
      timestamp: this.blockHeight,
    });
    this.state.batches.set(batchId, {
      ...batch,
      submissionCount: newCount,
      sumValues: newSum,
      sumSquares: newSq,
      minValue: newMin,
      maxValue: newMax,
    });

    return { ok: true, value: true };
  }

  closeAndAggregate(batchId: number): Result<{
    mean: number;
    variance: number;
    stdDev: number;
    count: number;
  }> {
    const batch = this.state.batches.get(batchId);
    if (!batch) return { ok: false, value: ERR_BATCH_NOT_FOUND };
    if (batch.status !== "open") return { ok: false, value: ERR_BATCH_CLOSED };
    if (batch.submissionCount < batch.kAnonymity)
      return { ok: false, value: ERR_INSUFFICIENT_DATA };

    const count = batch.submissionCount;
    const sum = batch.sumValues;
    const sumSq = batch.sumSquares;
    const minVal = batch.minValue!;
    const maxVal = batch.maxValue!;

    const mean = Math.floor((sum * 100) / count);
    const avgSq = Math.floor((sumSq * 100) / count);
    const meanSquared = Math.floor((mean * mean) / 100);
    const variance = avgSq >= meanSquared ? avgSq - meanSquared : 0;
    const stdDev = Math.floor(Math.sqrt(variance));

    this.state.batches.set(batchId, {
      ...batch,
      status: "closed",
      closedAt: this.blockHeight,
    });
    this.state.insights.set(batchId, {
      mean,
      variance,
      stdDev,
      count,
      minVal,
      maxVal,
      generatedAt: this.blockHeight,
    });

    return { ok: true, value: { mean, variance, stdDev, count } };
  }

  getBatch(batchId: number): Batch | null {
    return this.state.batches.get(batchId) || null;
  }

  getInsight(batchId: number): Insight | null {
    return this.state.insights.get(batchId) || null;
  }

  getUserSubmission(batchId: number, user: string): Submission | null {
    return this.state.submissions.get(this.key(batchId, user)) || null;
  }

  isBatchOpen(batchId: number): boolean {
    const batch = this.state.batches.get(batchId);
    return batch ? batch.status === "open" : false;
  }
}

describe("AggregationEngine", () => {
  let engine: AggregationEngineMock;

  beforeEach(() => {
    engine = new AggregationEngineMock();
    engine.reset();
  });

  it("creates batch with valid parameters", () => {
    const result = engine.createBatch("app-usage", 5);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const batch = engine.getBatch(0);
    expect(batch?.category).toBe("app-usage");
    expect(batch?.kAnonymity).toBe(5);
    expect(batch?.status).toBe("open");
  });

  it("rejects invalid category", () => {
    const result = engine.createBatch("invalid-cat", 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CATEGORY);
  });

  it("rejects k below minimum", () => {
    const result = engine.createBatch("app-usage", 2);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_K);
  });
  
  it("fails aggregation if below k", () => {
    engine.createBatch("location", 5);
    engine.submitData(0, 10, "location");
    engine.submitData(0, 20, "location");
    const result = engine.closeAndAggregate(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_DATA);
  });
});
