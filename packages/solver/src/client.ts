import { SolverUnavailable, type Admission, type FillOutcome, type FillRequest, type HedgeView, type PrepareTxOutcome, type PrepareTxRequest, type SolverHealth, type SolverPort, type SubmitTxRequest } from "./port.js";
import { fillRequestToWire, prepareTxRequestToWire, preparedTxFromWire } from "./wire.js";

export interface RemoteSolverOptions {
  /** Base URL of the solver service, for example `https://solver.internal:8788`. */
  url: string;
  /** The shared bearer secret. */
  token: string;
  /** The solver's public address, from configuration. The service must report the same one. */
  address: string;
  fetchImpl?: typeof fetch;
  /** Reads (health, status). Default 8s. */
  readTimeoutMs?: number;
  /** Fill, prepare, submit: the solver simulates, quotes and sends. Default 60s. */
  writeTimeoutMs?: number;
}

/**
 * The API's handle on a solver service. Holds a URL and a bearer token, never a key. Anything that goes wrong between here
 * and the service (no connection, timeout, a bad token, a 5xx, an answer that is not what was asked) is a `SolverUnavailable`,
 * which the API reports as a clean 503 instead of a stack trace. A `fill` that times out may still have been sent: submitting
 * the same signed order again is safe, because the service answers a repeated signature with the first fill's hash.
 */
export class RemoteSolver implements SolverPort {
  readonly address: string;
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly readMs: number;
  private readonly writeMs: number;
  constructor(private readonly o: RemoteSolverOptions) {
    this.address = o.address;
    this.base = o.url.replace(/\/+$/, "");
    this.f = o.fetchImpl ?? fetch;
    this.readMs = o.readTimeoutMs ?? 8_000;
    this.writeMs = o.writeTimeoutMs ?? 60_000;
  }

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, accept: number[] = [200]): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.o.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new SolverUnavailable(timedOut ? `the solver service did not answer within ${Math.round(timeoutMs / 1000)}s` : "the solver service could not be reached", (e as Error).message, timedOut ? "timeout" : "unreachable");
    }
    if (res.status === 401) throw new SolverUnavailable("the solver service refused our credentials", "401 unauthorized", "unauthorized");
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SolverUnavailable("the solver service sent something that is not JSON", `HTTP ${res.status}`, "bad_response");
    }
    if (!accept.includes(res.status)) throw new SolverUnavailable("the solver service failed", `HTTP ${res.status}: ${String((json as { error?: unknown })?.error ?? "").slice(0, 200)}`, "failed");
    return { status: res.status, json: json as T };
  }

  async health(): Promise<SolverHealth> {
    const { json } = await this.call<SolverHealth>("GET", "/health", undefined, this.readMs);
    if (!json || json.ok !== true || typeof json.address !== "string") throw new SolverUnavailable("the solver service sent a health report this version does not understand", undefined, "bad_response");
    if (json.address !== this.address) throw new SolverUnavailable("the solver service is a different solver than configured", `reports ${json.address}, expected ${this.address}`, "mismatch");
    return json;
  }

  async canFill(): Promise<Admission> {
    const h = await this.health();
    return h.accepting ? { ok: true } : { ok: false, reason: h.breaker ?? "the solver is not accepting fills" };
  }

  async fill(req: FillRequest): Promise<FillOutcome> {
    const { json } = await this.call<FillOutcome>("POST", "/fill", fillRequestToWire(req), this.writeMs);
    return this.outcome(json);
  }

  async prepareTx(req: PrepareTxRequest): Promise<PrepareTxOutcome> {
    const { json } = await this.call<{ kind: string; tx?: Record<string, unknown> }>("POST", "/prepare-tx", prepareTxRequestToWire(req), this.writeMs);
    if (json?.kind === "prepared") {
      const tx = json.tx ? preparedTxFromWire(json.tx) : undefined;
      if (!tx) throw new SolverUnavailable("the solver service sent a prepared transaction this version does not understand", undefined, "bad_response");
      return { kind: "prepared", tx };
    }
    return this.outcome(json as unknown as FillOutcome) as PrepareTxOutcome;
  }

  async submitTx(req: SubmitTxRequest): Promise<FillOutcome> {
    const { json } = await this.call<FillOutcome>("POST", "/submit-tx", { signedTx: req.signedTx }, this.writeMs);
    return this.outcome(json);
  }

  async orderStatus(hash: string): Promise<HedgeView | undefined> {
    const { json } = await this.call<{ known?: boolean; hedge?: HedgeView }>("GET", `/status/${hash}`, undefined, this.readMs);
    return json?.known && json.hedge ? json.hedge : undefined;
  }

  private outcome(json: FillOutcome): FillOutcome {
    if (!json || typeof json !== "object" || typeof (json as { kind?: unknown }).kind !== "string") throw new SolverUnavailable("the solver service sent an answer this version does not understand", undefined, "bad_response");
    return json;
  }
}
