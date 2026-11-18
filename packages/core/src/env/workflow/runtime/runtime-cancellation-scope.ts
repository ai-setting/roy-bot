/**
 * @fileoverview RuntimeCancellationScope — structured cancellation contract
 * owned by each workflow session (Task #2275).
 *
 * Why this exists:
 *   Before Task #2275, the engine's stop path was a loose combination of
 *   metadata update + executor.cancelAll() + cache eviction. The underlying
 *   `runWorkflow()` Promise could remain pending, cooperative runners could
 *   ignore a graceful signal, retry-backoff timers could survive a stop, and
 *   a second ESC had nothing to escalate.
 *
 *   `RuntimeCancellationScope` is the single, observable, runtime-owned
 *   cancellation surface. The engine creates one scope per active session,
 *   every node executor and AgentComponent receives the same scope (via
 *   `context.cancellationScope` + `context.abortSignal`), and the engine
 *   `stop()` path drives the scope through a deterministic state machine:
 *
 *       running ──cancel()──► graceful ──cancel({force:true})──► force
 *
 *   Each transition records the reason on its AbortSignal and fires
 *   registered cleanup handlers. The engine `waitForCleanup()` resolves
 *   once every tracked Promise has settled (or a bounded timeout elapses).
 *
 * Contract:
 *   - `signal`: combined "graceful+force" AbortSignal that listeners may
 *     use as a single source. Equivalent to `AbortSignal.any([...])`.
 *   - `forceSignal`: fires ONLY on `cancel({force:true})`. Useful for
 *     real-process kill paths that must not be triggered by a polite stop.
 *   - `level`: "running" | "graceful" | "force" — reflects current state.
 *   - `track(label, work)`: returns `work`'s settled Promise. Work identity
 *     (the Promise instance) is removed from tracking once it settles. Work
 *     errors propagate (NOT swallowed).
 *   - `onForce(label, handler)`: registers a handler invoked when the scope
 *     enters `force`. Returns an unsubscribe function.
 *   - `cancel(reason, options?)`: transitions to graceful OR force. Idempotent.
 *     Returns a CleanupReport aggregating handler errors.
 *   - `waitForCleanup(timeoutMs)`: returns once all tracked work settles or
 *     the timeout elapses.
 */

import { TracedAs } from "../../log-trace/decorator";

/**
 * Cancellation level reflects the current escalation stage of a scope.
 *   - "running": no cancellation requested yet.
 *   - "graceful": `cancel()` was called but no force yet.
 *   - "force": `cancel({force:true})` was called.
 */
export type CancellationLevel = "running" | "graceful" | "force";

/**
 * CleanupReport aggregates the outcome of `cancel()` and `waitForCleanup()`.
 *   - `completed`: true when every tracked Promise has settled.
 *   - `pendingLabels`: labels of work still pending at report time.
 *   - `errors`: cleanup-handler errors (NOT tracked-work errors).
 */
export interface CleanupReport {
  completed: boolean;
  pendingLabels: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * RuntimeCancellationScope — runtime-owned cancellation/cleanup contract.
 *
 * Thread-safety: single-threaded JavaScript; no concurrent access concerns.
 *
 * Idempotency:
 *   - `cancel()` after a graceful cancel is a no-op (no re-fire, no state change).
 *   - `cancel({force:true})` after a graceful cancel escalates to force and
 *     fires force handlers exactly once.
 *   - `cancel({force:true})` after a force cancel is a no-op.
 */
export class RuntimeCancellationScope {
  /** Graceful AbortController — fires on `cancel()` (any reason). */
  private readonly gracefulController = new AbortController();
  /** Force AbortController — fires only on `cancel({force:true})`. */
  private readonly forceController = new AbortController();
  /** Combined signal — fires on graceful OR force. */
  readonly signal: AbortSignal;
  /** Force-only signal — fires only on `cancel({force:true})`. */
  readonly forceSignal: AbortSignal;
  /** Current cancellation level. */
  private _level: CancellationLevel = "running";
  /** Tracked cleanup work, keyed by Promise identity. */
  private trackedWork: Map<Promise<unknown>, { label: string }> = new Map();
  /** Registered force handlers, in registration order. */
  private forceHandlers: Array<{ label: string; fn: () => void | Promise<void> }> = [];
  /** Captured handler errors from the most recent force fire. */
  private forceHandlerErrors: Array<{ label: string; error: string }> = [];

  constructor() {
    // Compose the two signals into one via AbortSignal.any().
    this.signal = AbortSignal.any([
      this.gracefulController.signal,
      this.forceController.signal,
    ]);
    this.forceSignal = this.forceController.signal;
  }

  get level(): CancellationLevel {
    return this._level;
  }

  /**
   * Track a Promise as cleanup work. Returns the work's settled Promise.
   * Work errors propagate (NOT swallowed) — the engine propagates them to
   * its own completedPromise via the existing error path.
   */
  track<T>(label: string, work: Promise<T>): Promise<T> {
    this.trackedWork.set(work as Promise<unknown>, { label });
    // Remove the entry once work settles (success OR failure).
    work.finally(() => {
      this.trackedWork.delete(work as Promise<unknown>);
    });
    return work;
  }

  /**
   * Register a force handler. Handler is invoked when the scope enters
   * `force`. Returns an unsubscribe function that detaches the handler.
   *
   * Handlers run in registration order. If a handler throws, the error is
   * captured into `CleanupReport.errors`; subsequent handlers still run.
   */
  onForce(label: string, handler: () => void | Promise<void>): () => void {
    const entry = { label, fn: handler };
    this.forceHandlers.push(entry);
    return () => {
      const idx = this.forceHandlers.indexOf(entry);
      if (idx >= 0) {
        this.forceHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Cancel the scope. Transitions:
   *   running → graceful: on any cancel() call.
   *   graceful → force:   on cancel({force:true}).
   *   force → force:      no-op (handlers do not re-fire).
   *
   * Returns a CleanupReport describing handler errors and pending work.
   */
  @TracedAs("workflow.runtime.cancel", { recordParams: true, recordResult: true })
  async cancel(
    reason: string,
    options: { force?: boolean } = {},
  ): Promise<CleanupReport> {
    const force = options.force === true;

    // Force escalation: must imply graceful first, THEN fire force.
    if (force) {
      if (!this.gracefulController.signal.aborted) {
        this.gracefulController.abort(reason);
        this._level = "graceful";
      }
      if (!this.forceController.signal.aborted) {
        this.forceController.abort(reason);
        this._level = "force";
      } else {
        // Force already fired — do not re-invoke handlers.
        return {
          completed: this.trackedWork.size === 0,
          pendingLabels: Array.from(this.trackedWork.values()).map((v) => v.label),
          errors: [...this.forceHandlerErrors],
        };
      }
    } else {
      // Graceful cancel: only fire if not already canceled.
      if (!this.gracefulController.signal.aborted) {
        this.gracefulController.abort(reason);
        this._level = "graceful";
      }
      // Pure graceful cancel does not fire force handlers.
      // The CleanupReport aggregates existing handler errors only.
      return {
        completed: this.trackedWork.size === 0,
        pendingLabels: Array.from(this.trackedWork.values()).map((v) => v.label),
        errors: [...this.forceHandlerErrors],
      };
    }

    // Force path: invoke registered force handlers.
    const handlers = [...this.forceHandlers];
    for (const { label, fn } of handlers) {
      try {
        await fn();
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        this.forceHandlerErrors.push({ label, error: err });
      }
    }

    return {
      completed: this.trackedWork.size === 0,
      pendingLabels: Array.from(this.trackedWork.values()).map((v) => v.label),
      errors: [...this.forceHandlerErrors],
    };
  }

  /**
   * Wait until every tracked Promise settles, or the timeout elapses.
   * Returns a CleanupReport.
   */
  @TracedAs("workflow.runtime.waitForCleanup", { recordParams: true, recordResult: true })
  async waitForCleanup(timeoutMs: number): Promise<CleanupReport> {
    const pendingPromises = Array.from(this.trackedWork.keys());
    if (pendingPromises.length === 0) {
      return {
        completed: true,
        pendingLabels: [],
        errors: [...this.forceHandlerErrors],
      };
    }
    const settled = Promise.allSettled(pendingPromises).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([settled, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      completed: this.trackedWork.size === 0,
      pendingLabels: Array.from(this.trackedWork.values()).map((v) => v.label),
      errors: [...this.forceHandlerErrors],
    };
  }
}