import { describe, it, expect, beforeEach } from "vitest";

const ERR_UNAUTHORIZED = 200;
const ERR_BATCH_NOT_AGGREGATED = 201;
const ERR_LISTING_EXISTS = 202;
const ERR_LISTING_NOT_FOUND = 203;
const ERR_INSUFFICIENT_PAYMENT = 204;
const ERR_BATCH_NOT_CLOSED = 205;
const ERR_INVALID_PRICE = 206;
const ERR_INVALID_DESCRIPTION = 207;
const ERR_ACCESS_DENIED = 208;
const ERR_MARKETPLACE_CLOSED = 209;

interface Listing {
  batchId: number;
  seller: string;
  price: number;
  description: string;
  sampleData: string;
  listedAt: number;
  active: boolean;
}

interface Purchase {
  purchasedAt: number;
  amountPaid: number;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class AggregationEngineMock {
  getInsight(batchId: number): any {
    if (batchId === 0) {
      return {
        mean: 15000,
        variance: 8333,
        stdDev: 91,
        count: 3,
        minVal: 100,
        maxVal: 200,
        generatedAt: 105,
      };
    }
    return null;
  }
  getBatch(batchId: number): any {
    if (batchId === 0) {
      return { status: "closed", submissionCount: 3, kAnonymity: 3 };
    }
    return null;
  }
}

class InsightMarketplaceMock {
  state: {
    marketplaceOwner: string;
    marketplaceFeeRate: number;
    marketplaceActive: boolean;
    listings: Map<number, Listing>;
    purchases: Map<string, Purchase>;
  } = {
    marketplaceOwner: "ST1OWNER",
    marketplaceFeeRate: 500,
    marketplaceActive: true,
    listings: new Map(),
    purchases: new Map(),
  };

  blockHeight: number = 100;
  caller: string = "ST1SELLER";
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];
  aggregationEngine = new AggregationEngineMock();

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      marketplaceOwner: "ST1OWNER",
      marketplaceFeeRate: 500,
      marketplaceActive: true,
      listings: new Map(),
      purchases: new Map(),
    };
    this.blockHeight = 100;
    this.caller = "ST1SELLER";
    this.stxTransfers = [];
  }

  private listingId(batchId: number): number {
    return batchId; // Simplified deterministic ID
  }

  createListing(
    batchId: number,
    price: number,
    description: string,
    sampleData: string
  ): Result<number> {
    if (!this.state.marketplaceActive)
      return { ok: false, value: ERR_MARKETPLACE_CLOSED };
    if (price <= 0) return { ok: false, value: ERR_INVALID_PRICE };
    if (!description || description.length > 256)
      return { ok: false, value: ERR_INVALID_DESCRIPTION };
    if (this.aggregationEngine.getInsight(batchId) === null)
      return { ok: false, value: ERR_BATCH_NOT_AGGREGATED };
    if (this.aggregationEngine.getBatch(batchId)?.status !== "closed")
      return { ok: false, value: ERR_BATCH_NOT_CLOSED };

    const listingId = this.listingId(batchId);
    if (this.state.listings.has(listingId))
      return { ok: false, value: ERR_LISTING_EXISTS };

    this.state.listings.set(listingId, {
      batchId,
      seller: this.caller,
      price,
      description,
      sampleData,
      listedAt: this.blockHeight,
      active: true,
    });
    return { ok: true, value: listingId };
  }

  updateListing(
    listingId: number,
    newPrice: number,
    newDescription: string
  ): Result<boolean> {
    const listing = this.state.listings.get(listingId);
    if (!listing) return { ok: false, value: ERR_LISTING_NOT_FOUND };
    if (listing.seller !== this.caller)
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (!listing.active) return { ok: false, value: ERR_LISTING_NOT_FOUND };
    if (newPrice <= 0) return { ok: false, value: ERR_INVALID_PRICE };
    if (!newDescription || newDescription.length > 256)
      return { ok: false, value: ERR_INVALID_DESCRIPTION };

    this.state.listings.set(listingId, {
      ...listing,
      price: newPrice,
      description: newDescription,
    });
    return { ok: true, value: true };
  }

  deactivateListing(listingId: number): Result<boolean> {
    const listing = this.state.listings.get(listingId);
    if (!listing) return { ok: false, value: ERR_LISTING_NOT_FOUND };
    if (listing.seller !== this.caller)
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (!listing.active) return { ok: false, value: ERR_LISTING_NOT_FOUND };

    this.state.listings.set(listingId, { ...listing, active: false });
    return { ok: true, value: true };
  }

  purchaseInsight(listingId: number): Result<any> {
    const listing = this.state.listings.get(listingId);
    if (!listing) return { ok: false, value: ERR_LISTING_NOT_FOUND };
    if (!this.state.marketplaceActive)
      return { ok: false, value: ERR_MARKETPLACE_CLOSED };
    if (!listing.active) return { ok: false, value: ERR_LISTING_NOT_FOUND };

    const purchaseKey = `${listingId}-${this.caller}`;
    if (this.state.purchases.has(purchaseKey))
      return { ok: false, value: ERR_ACCESS_DENIED };

    const fee = Math.floor(
      (listing.price * this.state.marketplaceFeeRate) / 10000
    );
    const payout = listing.price - fee;

    this.stxTransfers.push({
      amount: listing.price,
      from: this.caller,
      to: "contract",
    });
    this.stxTransfers.push({
      amount: fee,
      from: "contract",
      to: this.state.marketplaceOwner,
    });
    this.stxTransfers.push({
      amount: payout,
      from: "contract",
      to: listing.seller,
    });

    this.state.purchases.set(purchaseKey, {
      purchasedAt: this.blockHeight,
      amountPaid: listing.price,
    });

    const insight = this.aggregationEngine.getInsight(listing.batchId);
    return {
      ok: true,
      value: {
        batchId: listing.batchId,
        insight: insight!,
        sample: listing.sampleData,
      },
    };
  }

  setMarketplaceFeeRate(newRate: number): Result<boolean> {
    if (this.caller !== this.state.marketplaceOwner)
      return { ok: false, value: ERR_UNAUTHORIZED };
    if (newRate > 1000) return { ok: false, value: ERR_INVALID_PRICE };
    this.state.marketplaceFeeRate = newRate;
    return { ok: true, value: true };
  }

  toggleMarketplace(active: boolean): Result<boolean> {
    if (this.caller !== this.state.marketplaceOwner)
      return { ok: false, value: ERR_UNAUTHORIZED };
    this.state.marketplaceActive = active;
    return { ok: true, value: true };
  }

  transferOwnership(newOwner: string): Result<boolean> {
    if (this.caller !== this.state.marketplaceOwner)
      return { ok: false, value: ERR_UNAUTHORIZED };
    this.state.marketplaceOwner = newOwner;
    return { ok: true, value: true };
  }

  getAllActiveListings(): number[] {
    const result: number[] = [];
    this.state.listings.forEach((listing, id) => {
      if (listing.active && this.state.marketplaceActive) {
        result.push(id);
      }
    });
    return result.slice(0, 10);
  }
}

describe("InsightMarketplace", () => {
  let marketplace: InsightMarketplaceMock;

  beforeEach(() => {
    marketplace = new InsightMarketplaceMock();
    marketplace.reset();
  });

  it("creates listing for aggregated batch", () => {
    const result = marketplace.createListing(
      0,
      1000000,
      "Daily app usage stats",
      "Sample: mean=150min"
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const listing = marketplace.state.listings.get(0);
    expect(listing?.price).toBe(1000000);
    expect(listing?.seller).toBe("ST1SELLER");
  });

  it("rejects listing if batch not aggregated", () => {
    const result = marketplace.createListing(
      999,
      1000000,
      "Invalid batch",
      "Sample"
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BATCH_NOT_AGGREGATED);
  });

  it("rejects listing if batch not closed", () => {
    const mockEngine: any = marketplace as any;
    mockEngine.aggregationEngine.getBatch = () => ({ status: "open" });
    const result = marketplace.createListing(
      0,
      1000000,
      "Open batch",
      "Sample"
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BATCH_NOT_CLOSED);
  });

  it("prevents duplicate listings", () => {
    marketplace.createListing(0, 1000000, "First", "Sample1");
    const result = marketplace.createListing(0, 2000000, "Second", "Sample2");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_LISTING_EXISTS);
  });

  it("allows seller to update listing", () => {
    marketplace.createListing(0, 1000000, "Old desc", "Old sample");
    const result = marketplace.updateListing(0, 1500000, "New desc");
    expect(result.ok).toBe(true);
    const listing = marketplace.state.listings.get(0);
    expect(listing?.price).toBe(1500000);
    expect(listing?.description).toBe("New desc");
  });

  it("prevents non-seller from updating", () => {
    marketplace.createListing(0, 1000000, "Desc", "Sample");
    marketplace.caller = "ST2HACKER";
    const result = marketplace.updateListing(0, 2000000, "Hack");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("allows seller to deactivate listing", () => {
    marketplace.createListing(0, 1000000, "Desc", "Sample");
    const result = marketplace.deactivateListing(0);
    expect(result.ok).toBe(true);
    const listing = marketplace.state.listings.get(0);
    expect(listing?.active).toBe(false);
  });

  it("executes purchase with correct payouts", () => {
    marketplace.createListing(0, 1000000, "App stats", "Sample data");
    marketplace.caller = "ST1BUYER";
    const result = marketplace.purchaseInsight(0);
    expect(result.ok).toBe(true);
    expect(result.value.insight.mean).toBe(15000);
    expect(marketplace.stxTransfers).toEqual([
      { amount: 1000000, from: "ST1BUYER", to: "contract" },
      { amount: 50000, from: "contract", to: "ST1OWNER" },
      { amount: 950000, from: "contract", to: "ST1SELLER" },
    ]);
  });

  it("prevents double purchase", () => {
    marketplace.createListing(0, 1000000, "Desc", "Sample");
    marketplace.caller = "ST1BUYER";
    marketplace.purchaseInsight(0);
    const result = marketplace.purchaseInsight(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ACCESS_DENIED);
  });

  it("owner can toggle marketplace", () => {
    marketplace.caller = "ST1OWNER";
    marketplace.toggleMarketplace(false);
    expect(marketplace.state.marketplaceActive).toBe(false);
    marketplace.caller = "ST1SELLER";
    const result = marketplace.createListing(0, 1000000, "Desc", "Sample");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MARKETPLACE_CLOSED);
  });

  it("owner can transfer ownership", () => {
    marketplace.caller = "ST1OWNER";
    marketplace.transferOwnership("ST2NEW");
    expect(marketplace.state.marketplaceOwner).toBe("ST2NEW");
  });

  it("returns active listings", () => {
    marketplace.createListing(0, 1000000, "A", "S1");
    marketplace.caller = "ST2SELLER";
    marketplace.createListing(0, 2000000, "B", "S2");
    const ids = marketplace.getAllActiveListings();
    expect(ids).toContain(0);
  });

  it("excludes deactivated listings", () => {
    marketplace.createListing(0, 1000000, "Desc", "Sample");
    marketplace.deactivateListing(0);
    const ids = marketplace.getAllActiveListings();
    expect(ids).not.toContain(0);
  });
});
