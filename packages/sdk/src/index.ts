export interface RouteLeg {
  venue: string;
  layer: "classic" | "soroban";
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
  minOut: string;
  hops: string[];
}
export interface RouteQuote {
  /** Names this route across re-quotes. Pass it to `build` as `routeKey`. */
  key: string;
  atomicity: "ATOMIC_SOROBAN" | "CLASSIC_ONLY" | "TWO_STEP";
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
  effectiveOut: string;
  risks: { code: string; message: string }[];
  legs: RouteLeg[];
}
export interface QuoteResponse {
  routes: RouteQuote[];
  best: RouteQuote | null;
  partial: boolean;
  errors: { source: string; error: string }[];
}

export type BuildStep =
  | { kind: "prerequisite"; type: "changeTrust"; asset: string; xdr: string; reason: string }
  | { kind: "transaction"; leg: number; layer: "classic" | "soroban"; venue: string; xdr: string; needsSimulation: boolean; minOut: string; resourceFee?: string; simulated?: false; note?: string }
  | { kind: "deferred"; leg: number; layer: "classic" | "soroban"; venue: string; reason: string }
  | { kind: "unsupported"; leg: number; venue: string; reason: string };
export interface BuildResponse {
  route: RouteQuote;
  steps: BuildStep[];
  unsigned: true;
  /** Routes tried before this one whose simulation failed (only when no route was named). */
  skipped: { venue: string; error: string }[];
}

export interface DepositResponse { kind: "transaction"; venue: string; xdr: string; resourceFee: string; unsigned: true }

/** A failure put in words a user can act on, with a stable code and the raw first line for details. */
export interface Explained { code: string; message: string; detail: string }

export interface ListedAsset {
  /** "native" or "CODE:ISSUER". */
  id: string;
  code: string;
  issuer?: string;
  /** Stellar Asset Contract id. */
  contract: string;
  name?: string;
  domain?: string;
  icon?: string;
  lists: string[];
}
export interface AssetsResponse { assets: ListedAsset[]; errors: { source: string; error: string }[]; at: number }
export interface AssetInfo { id: string; code: string; issuer?: string; contract: string; authRequired?: boolean; clawback?: boolean; holders?: number }

export interface Balance { asset: string; balance: string; spendable: string; limit?: string; authorized: boolean }
export interface AccountResponse { account: string; sequence: string; balances: Balance[] }

export interface SubmitResponse { hash: string; status: "PENDING" | "DUPLICATE" }
export interface TxResponse {
  hash: string;
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  ledger?: number;
  createdAt?: number;
  /** What a settled swap actually delivered, decimal string. */
  received?: string;
  explained?: Explained;
}

export interface StablecoinSignals { pegPrice?: number; depthNearPeg?: number; reference?: boolean; authRequired: boolean; clawback: boolean; sizesProbed: number[] }
export interface StablecoinScore { score: number; penaltyBps: number; reasons: string[]; signals: StablecoinSignals }
export type ScoredStablecoin = ({ asset: string; at: number } & StablecoinScore) | { asset: string; error: string };

export interface VaultReserve {
  asset: string;
  contract: string;
  index: number;
  supplied: string;
  borrowed: string;
  utilization: number;
  supplyApr: number;
  borrowApr: number;
  capRemaining: string;
}
export interface Vault { protocol: "blend"; name: string; id: string; status: number; statusLabel: string; supplyOpen: boolean; reserves: VaultReserve[] }
export interface VaultsResponse { vaults: Vault[]; errors: { vault: string; error: string }[] }
export interface PositionsResponse {
  account: string;
  vaults: { protocol: "blend"; vault: string; name: string; positions: { asset: string; supplied: string; collateral: string }[] }[];
  errors: { vault: string; error: string }[];
}

export class SluiceError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Present when the server could say why in plain words. */
    public explained?: Explained,
    /** The parsed error body, for fields such as `code` or `skipped`. */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class Sluice {
  // The default wraps fetch instead of storing it: a browser's fetch throws "Illegal invocation" when called as a method of another object.
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async request<T>(path: string, init?: { query?: Record<string, string | undefined>; body?: unknown }): Promise<T> {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    const res = init?.body === undefined
      ? await this.fetchImpl(u)
      : await this.fetchImpl(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; explained?: Explained };
    if (!res.ok) throw new SluiceError(res.status, body.error ?? `HTTP ${res.status}`, body.explained, body as Record<string, unknown>);
    return body;
  }

  quote(p: { assetIn: string; assetOut: string; amount: string; slippageBps?: number; atomicOnly?: boolean }): Promise<QuoteResponse> {
    return this.request("/v1/quote", {
      query: { assetIn: p.assetIn, assetOut: p.assetOut, amount: p.amount, slippageBps: p.slippageBps === undefined ? undefined : String(p.slippageBps), atomicOnly: p.atomicOnly ? "1" : undefined },
    });
  }

  /**
   * Build unsigned transactions for a route. The caller signs and submits; nothing is sent here. Name the
   * route with `routeKey` from a quote; without it the best route is used, with fallback to the next.
   */
  build(p: {
    assetIn: string; assetOut: string; amount: string; account: string;
    slippageBps?: number; atomicOnly?: boolean; routeKey?: string; routeIndex?: number;
  }): Promise<BuildResponse> {
    return this.request("/v1/build", { body: p });
  }

  /** Unsigned, simulated Blend deposit. For a zap, call this with the amount the swap actually delivered. */
  deposit(p: { account: string; vault: string; asset: string; amount: string; protocol?: "blend" }): Promise<DepositResponse> {
    return this.request("/v1/deposit", { body: { protocol: "blend", ...p } });
  }

  /** Unsigned, simulated Blend withdrawal. Asking for more than the position withdraws all of it. */
  withdraw(p: { account: string; vault: string; asset: string; amount: string; protocol?: "blend" }): Promise<DepositResponse> {
    return this.request("/v1/withdraw", { body: { protocol: "blend", ...p } });
  }

  /**
   * Recovery for a two-step route whose second leg failed: you hold `heldAsset` from leg 1. This builds the
   * route back to `originalAsset` for the amount you actually hold. It does not retry leg 2: re-quote and decide.
   */
  unwind(p: { account: string; heldAsset: string; originalAsset: string; heldAmount: string; slippageBps?: number }): Promise<BuildResponse> {
    return this.build({ account: p.account, assetIn: p.heldAsset, assetOut: p.originalAsset, amount: p.heldAmount, slippageBps: p.slippageBps, atomicOnly: true });
  }

  /** Relay a transaction the user's wallet has signed. Then poll `tx(hash)`. */
  submit(signedXdr: string): Promise<SubmitResponse> {
    return this.request("/v1/submit", { body: { xdr: signedXdr } });
  }

  tx(hash: string): Promise<TxResponse> {
    return this.request(`/v1/tx/${hash}`);
  }

  /**
   * Poll until the transaction is in a ledger. Resolves with SUCCESS or FAILED; rejects with status 408 if it
   * has not appeared within `timeoutMs` (it may still land: keep the hash).
   */
  async waitForTx(hash: string, o: { timeoutMs?: number; intervalMs?: number } = {}): Promise<TxResponse> {
    const deadline = Date.now() + (o.timeoutMs ?? 90_000);
    for (;;) {
      const t = await this.tx(hash);
      if (t.status !== "NOT_FOUND") return t;
      if (Date.now() >= deadline) throw new SluiceError(408, "transaction not found in a ledger yet");
      await new Promise((r) => setTimeout(r, o.intervalMs ?? 1500));
    }
  }

  assets(): Promise<AssetsResponse> {
    return this.request("/v1/assets");
  }

  /** Confirm a `CODE:ISSUER` exists on the network. Rejects with status 404 when it does not. */
  asset(id: string): Promise<AssetInfo> {
    return this.request("/v1/asset", { query: { id } });
  }

  /** Balances and spendable amounts. Rejects with status 404 for an unfunded account. */
  account(id: string): Promise<AccountResponse> {
    return this.request(`/v1/account/${id}`);
  }

  stablecoin(asset: string): Promise<StablecoinScore> {
    return this.request("/v1/stablecoin", { query: { asset } });
  }

  stablecoins(): Promise<{ assets: ScoredStablecoin[] }> {
    return this.request("/v1/stablecoins");
  }

  vaults(): Promise<VaultsResponse> {
    return this.request("/v1/vaults");
  }

  positions(account: string): Promise<PositionsResponse> {
    return this.request("/v1/positions", { query: { account } });
  }
}
