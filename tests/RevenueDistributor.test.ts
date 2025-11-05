import { describe, it, expect, beforeEach } from "vitest";

const ERR_UNAUTHORIZED = 300;
const ERR_BATCH_NOT_SOLD = 301;
const ERR_DISTRIBUTION_CLAIMED = 303;
const ERR_INVALID_SHARE = 304;
const ERR_BATCH_NOT_FOUND = 305;
const ERR_CLAIM_WINDOW_CLOSED = 306;
const ERR_ZERO_VALUE = 307;

interface Contribution {
  value: number;
  weight: number;
  claimed: boolean;
}

interface BatchRevenue {
  totalRevenue: number;
  totalWeight: number;
  distributed: boolean;
  saleBlock: number;
  listingId: number | null;
}

interface Claim {
  amount: number;
  claimedAt: number | null;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class InsightMarketplaceMock {
  getContractAddress(): string {
    return "ST_MARKETPLACE";
  }
}

class RevenueDistributorMock {
  state: {
    claimWindowBlocks: number;
    distributorAdmin: string;
    contributions: Map<string, Contribution>;
    batchRevenue: Map<number, BatchRevenue>;
    claims: Map<string, Claim>;
    currentBatchId: number;
  } = {
    claimWindowBlocks: 100,
    distributorAdmin: "ST1ADMIN",
    contributions: new Map(),
    batchRevenue: new Map(),
    claims: new Map(),
    currentBatchId: 0,
  };

  blockHeight: number = 200;
  caller: string = "ST1ADMIN";
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];
  marketplace = new InsightMarketplaceMock();

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      claimWindowBlocks: 100,
      distributorAdmin: "ST1ADMIN",
      contributions: new Map(),
      batchRevenue: new Map(),
      claims: new Map(),
      currentBatchId: 0,
    };
    this.blockHeight = 200;
    this.caller = "ST1ADMIN";
    this.stxTransfers = [];
  }

  private contribKey(batchId: number, contributor: string): string {
    return `${batchId}-${contributor}`;
  }

  private claimKey(batchId: number, contributor: string): string {
    return `${batchId}-${contributor}`;
  }

  registerContribution(
    batchId: number,
    contributor: string,
    value: number,
    weight: number
  ): Result<boolean> {
    if (this.caller !== this.state.distributorAdmin)
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (value <= 0 || weight <= 0) return { ok: false, value: ERR_ZERO_VALUE };

    const key = this.contribKey(batchId, contributor);
    this.state.contributions.set(key, { value, weight, claimed: false });
    return { ok: true, value: true };
  }

  recordSale(
    batchId: number,
    listingId: number,
    revenue: number
  ): Result<boolean> {
    if (this.caller !== this.marketplace.getContractAddress())
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (this.state.batchRevenue.has(batchId))
      return { ok: false, value: ERR_BATCH_NOT_SOLD };
    if (revenue <= 0) return { ok: false, value: ERR_ZERO_VALUE };

    const weights = Array.from(this.state.contributions.keys())
      .filter((k) => k.startsWith(`${batchId}-`))
      .reduce(
        (sum, k) => sum + (this.state.contributions.get(k)?.weight || 0),
        0
      );

    if (weights <= 0) return { ok: false, value: 302 }; // ERR_INSUFFICIENT_SHARES

    this.state.batchRevenue.set(batchId, {
      totalRevenue: revenue,
      totalWeight: weights,
      distributed: false,
      saleBlock: this.blockHeight,
      listingId,
    });
    return { ok: true, value: true };
  }

  claimRevenue(batchId: number): Result<number> {
    const contributor = this.caller;
    const contribKey = this.contribKey(batchId, contributor);
    const contrib = this.state.contributions.get(contribKey);
    if (!contrib) return { ok: false, value: ERR_BATCH_NOT_FOUND };

    const revenueData = this.state.batchRevenue.get(batchId);
    if (!revenueData) return { ok: false, value: ERR_BATCH_NOT_SOLD };

    if (contrib.claimed) return { ok: false, value: ERR_DISTRIBUTION_CLAIMED };

    const windowEnd = revenueData.saleBlock + this.state.claimWindowBlocks;
    if (this.blockHeight > windowEnd)
      return { ok: false, value: ERR_CLAIM_WINDOW_CLOSED };

    const share = Math.floor(
      (contrib.weight * revenueData.totalRevenue) / revenueData.totalWeight
    );
    if (share <= 0) return { ok: false, value: ERR_ZERO_VALUE };

    this.stxTransfers.push({
      amount: share,
      from: "contract",
      to: contributor,
    });
    this.state.contributions.set(contribKey, { ...contrib, claimed: true });
    this.state.claims.set(this.claimKey(batchId, contributor), {
      amount: share,
      claimedAt: this.blockHeight,
    });

    return { ok: true, value: share };
  }

  emergencyWithdraw(batchId: number): Result<boolean> {
    if (this.caller !== this.state.distributorAdmin)
      return { ok: false, value: ERR_UNAUTHORIZED };
    const revenueData = this.state.batchRevenue.get(batchId);
    if (!revenueData) return { ok: false, value: ERR_BATCH_NOT_FOUND };
    if (revenueData.distributed) return { ok: false, value: ERR_UNAUTHORIZED };

    const windowEnd = revenueData.saleBlock + this.state.claimWindowBlocks;
    if (this.blockHeight <= windowEnd)
      return { ok: false, value: ERR_CLAIM_WINDOW_CLOSED };

    this.state.batchRevenue.set(batchId, { ...revenueData, distributed: true });
    this.stxTransfers.push({
      amount: revenueData.totalRevenue,
      from: "contract",
      to: this.state.distributorAdmin,
    });
    return { ok: true, value: true };
  }

  setClaimWindow(blocks: number): Result<boolean> {
    if (this.caller !== this.state.distributorAdmin)
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (blocks <= 10) return { ok: false, value: ERR_ZERO_VALUE };
    this.state.claimWindowBlocks = blocks;
    return { ok: true, value: true };
  }

  transferAdmin(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.distributorAdmin)
      return { ok: false, value: ERR_UNAUTHORIZED };
    this.state.distributorAdmin = newAdmin;
    return { ok: true, value: true };
  }

  getContractAddress(): string {
    return "ST_DISTRIBUTOR";
  }
}

describe("RevenueDistributor", () => {
  let distributor: RevenueDistributorMock;

  beforeEach(() => {
    distributor = new RevenueDistributorMock();
    distributor.reset();
  });

  it("registers contributions by admin", () => {
    const result = distributor.registerContribution(0, "ST1USER", 120, 10);
    expect(result.ok).toBe(true);
    const contrib = distributor.state.contributions.get("0-ST1USER");
    expect(contrib?.weight).toBe(10);
  });

  it("distributes revenue proportionally", () => {
    distributor.registerContribution(0, "ST1USER", 100, 5);
    distributor.registerContribution(0, "ST2USER", 200, 15);
    distributor.caller = "ST_MARKETPLACE";
    distributor.recordSale(0, 123, 1000000);
    distributor.caller = "ST1USER";
    const result = distributor.claimRevenue(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(250000); // 5/20 * 1M
  });

  it("prevents double claim", () => {
    distributor.registerContribution(0, "ST1USER", 100, 10);
    distributor.caller = "ST_MARKETPLACE";
    distributor.recordSale(0, 123, 1000000);
    distributor.caller = "ST1USER";
    distributor.claimRevenue(0);
    const result = distributor.claimRevenue(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_DISTRIBUTION_CLAIMED);
  });

  it("enforces claim window", () => {
    distributor.registerContribution(0, "ST1USER", 100, 10);
    distributor.caller = "ST_MARKETPLACE";
    distributor.recordSale(0, 123, 1000000);
    distributor.blockHeight = 1000;
    distributor.state.claimWindowBlocks = 100;
    distributor.caller = "ST1USER";
    const result = distributor.claimRevenue(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CLAIM_WINDOW_CLOSED);
  });

  it("admin can update claim window", () => {
    const result = distributor.setClaimWindow(200);
    expect(result.ok).toBe(true);
    expect(distributor.state.claimWindowBlocks).toBe(200);
  });

  it("admin can transfer admin role", () => {
    const result = distributor.transferAdmin("ST2NEW");
    expect(result.ok).toBe(true);
    expect(distributor.state.distributorAdmin).toBe("ST2NEW");
  });
});
