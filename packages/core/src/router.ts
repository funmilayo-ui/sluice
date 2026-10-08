import { applyBps } from "./amounts.js";
import { classify } from "./classify.js";
import type { AssetId, Leg, QuoteRequest, RiskNote, Route, RouterConfig } from "./types.js";
import { withTimeout } from "./withTimeout.js";

const DEFAULT_SLIPPAGE_BPS = 50;
/**
 * A TWO_STEP route must beat the best atomic route by more than this to rank first. 50 bps was chosen
 * after a live XLM to AQUA quote where a 15 bps haircut let a 0.18% raw edge outrank an atomic route.
 * It is a policy default, not a derived number: tune it against failure data.
 */
const DEFAULT_TWO_STEP_PENALTY_BPS = 50;

interface Sourced {
  leg: Leg | null;
  error?: string;
}

export interface QuoteResult {
  routes: Route[];
  /** Sources that threw or timed out; routes are best-effort when this is non-empty. */
  errors: { source: string; error: string }[];
}

export class Router {
  constructor(private readonly cfg: RouterConfig) {}

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const errors: QuoteResult["errors"] = [];
    const timeout = this.cfg.timeoutMs ?? 4000;

    const ask = async (r: QuoteRequest): Promise<Leg[]> => {
      const out = await Promise.all(
        this.cfg.sources.map(async (s): Promise<Sourced> => {
          try {
            return { leg: await withTimeout(s.quote(r), timeout, s.id) };
          } catch (e) {
            errors.push({ source: s.id, error: (e as Error).message });
            return { leg: null, error: String(e) };
          }
        }),
      );
      return out.flatMap((o) => (o.leg ? [o.leg] : []));
    };

    // Single-venue routes: every source asked for the full pair.
    const direct = await ask(req);
    const routes: Route[] = direct.map((l) => this.build(req, [l]));

    // Cross-layer routes: bridge through a hub, Classic then Soroban or the reverse.
    const hubs = this.cfg.hubs.filter((h) => h !== req.assetIn && h !== req.assetOut);
    const bridged = await Promise.all(hubs.map((h) => this.bridge(req, h, ask)));
    for (const r of bridged.flat()) routes.push(r);

    routes.sort((a, b) => (a.effectiveOut === b.effectiveOut ? 0 : a.effectiveOut > b.effectiveOut ? -1 : 1));
    return { routes: dedupe(routes), errors };
  }

  private async bridge(
    req: QuoteRequest,
    hub: AssetId,
    ask: (r: QuoteRequest) => Promise<Leg[]>,
  ): Promise<Route[]> {
    const firstLegs = await ask({ ...req, assetOut: hub });
    const out: Route[] = [];
    await Promise.all(
      firstLegs.map(async (first) => {
        if (first.amountOut <= 0n) return;
        const seconds = await ask({ ...req, assetIn: hub, assetOut: req.assetOut, amountIn: first.amountOut });
        for (const second of seconds) {
          if (first.layer === second.layer) {
            // Same-layer pairs are covered by each venue's own direct quote, except two different venues that
            // the Sluice contract can chain inside one invocation.
            const chain = new Set(this.cfg.chainVenues ?? []);
            if (!(chain.has(first.venue) && chain.has(second.venue) && first.venue !== second.venue)) continue;
          }
          out.push(this.build(req, [first, second]));
        }
      }),
    );
    return out;
  }

  private build(req: QuoteRequest, legs: Leg[]): Route {
    const atomicity = classify(legs);
    const slippage = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const last = legs[legs.length - 1]!;
    const risks: RiskNote[] = [];
    let effective = last.amountOut;

    if (atomicity === "TWO_STEP") {
      const bps = this.cfg.twoStepPenaltyBps ?? DEFAULT_TWO_STEP_PENALTY_BPS;
      effective = applyBps(effective, bps);
      risks.push({
        code: "NON_ATOMIC",
        message:
          "Classic and Soroban legs are separate transactions (Soroban allows one operation per transaction). " +
          "If leg 2 fails you hold the intermediate asset.",
      });
    }

    const touched = new Set<AssetId>();
    for (const l of legs) for (const a of [l.assetIn, l.assetOut, ...l.hops]) touched.add(a);
    if (this.cfg.assetPenaltyBps) {
      let worst = 0;
      let culprit: AssetId | undefined;
      for (const a of touched) {
        const p = this.cfg.assetPenaltyBps(a);
        if (p > worst) [worst, culprit] = [p, a];
      }
      if (worst > 0 && culprit) {
        effective = applyBps(effective, worst);
        // Name the asset: a warning that does not say what it is about cannot be acted on.
        const code = culprit === "native" ? "XLM" : culprit.split(":")[0];
        risks.push({ code: "STABLECOIN_PENALTY", message: `This route passes through ${code}, which is ranked down by ${worst} bps for its current health score.` });
      }
    }

    return {
      legs,
      atomicity,
      assetIn: req.assetIn,
      assetOut: req.assetOut,
      amountIn: req.amountIn,
      amountOut: last.amountOut,
      effectiveOut: effective,
      minOuts: legs.map((l) => applyBps(l.amountOut, slippage)),
      risks,
    };
  }
}

/**
 * Identity of a route that survives a re-quote: the venue chain and the pair each leg trades, without amounts.
 * A client quotes, shows routes, then asks for one by key; an index would point at a different route as soon
 * as prices move and the list re-sorts.
 */
export function routeKey(r: Pick<Route, "legs">): string {
  return r.legs.map((l) => `${l.venue}:${l.assetIn}>${l.assetOut}`).join("|");
}

function dedupe(routes: Route[]): Route[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const k = r.legs.map((l) => `${l.venue}:${l.assetIn}>${l.assetOut}:${l.amountIn}`).join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
