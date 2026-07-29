/**
 * Relay worker runtime.
 *
 * Spec: `13-event-platform/workers.md`.
 *
 * THERE IS EXACTLY ONE WORKER BINARY. It hosts any set of registered handlers,
 * selected by configuration — there is no "analytics worker" program distinct
 * from an "embedding worker". That keeps deployment uniform and makes
 * rebalancing a config change rather than a build.
 *
 * This module COMPOSES the platform; it reimplements nothing. The relay claims
 * and publishes, the dispatcher enforces barrier → idempotency → handler, the
 * retry engine decides fate, the DLQ absorbs terminal failures. The worker's
 * own job is only the lifecycle: poll, recover, and stop cleanly.
 */

export type WorkerStatus = 'starting' | 'ready' | 'draining' | 'stopped';

export interface WorkerHealth {
  readonly status: WorkerStatus;
  readonly hostedGroups: readonly string[];
  readonly inFlight: number;
  readonly lastCycleAt: Date | null;
  readonly cyclesCompleted: number;
  readonly startedAt: Date;
}

export interface CycleOutcome {
  readonly relayed: number;
  readonly recovered: number;
}

export interface RelayWorkerDeps {
  /** One relay drain. Returns how many rows it moved, so idle backs off. */
  readonly drainOutbox: () => Promise<number>;
  /**
   * Recover entries a dead consumer read but never acked (XAUTOCLAIM).
   * Returns how many were reclaimed.
   */
  readonly recoverPending: () => Promise<number>;
  readonly hostedGroups: readonly string[];
  /** Interval between cycles when there was nothing to do. */
  readonly idleIntervalMs?: number;
  /** Interval when the last cycle did work — drain fast while there is a backlog. */
  readonly busyIntervalMs?: number;
  /** Pending recovery runs every Nth cycle; it is a sweep, not a hot path. */
  readonly recoverEveryCycles?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly onCycle?: (outcome: CycleOutcome) => void;
  readonly onError?: (error: unknown) => void;
}

export const DEFAULT_IDLE_INTERVAL_MS = 1000;
export const DEFAULT_BUSY_INTERVAL_MS = 50;
export const DEFAULT_RECOVER_EVERY_CYCLES = 30;

/**
 * Yield to the event loop, once per cycle.
 *
 * THIS IS A LIVENESS REQUIREMENT, NOT A COURTESY. The poll loop is pure promise
 * work, and `await` on an already-resolved promise drains only the MICROTASK
 * queue — the event loop never reaches its timers or poll phases. A loop whose
 * configured interval resolves immediately therefore starves the process:
 * timers never fire, sockets are never read, and the SIGTERM handler that
 * `bindShutdownSignals` registered can never run. The worker would spin until
 * the orchestrator escalated to SIGKILL and killed it mid-publish.
 *
 * `setImmediate` costs one event-loop turn per cycle and makes that
 * unrepresentable, independent of how the injected `sleep` behaves.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface RelayWorker {
  /** Runs until `shutdown` is called. Resolves once the loop has stopped. */
  start(): Promise<void>;
  /**
   * Stop accepting new work, finish what is in flight, then resolve.
   * Idempotent: a second SIGTERM must not cut the first drain short.
   */
  shutdown(): Promise<void>;
  health(): WorkerHealth;
  /** One cycle, for tests and for a one-shot drain. */
  runCycle(): Promise<CycleOutcome>;
}

export function createRelayWorker(deps: RelayWorkerDeps): RelayWorker {
  const idleMs = deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  const busyMs = deps.busyIntervalMs ?? DEFAULT_BUSY_INTERVAL_MS;
  const recoverEvery = deps.recoverEveryCycles ?? DEFAULT_RECOVER_EVERY_CYCLES;
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? ((): Date => new Date());

  const startedAt = now();
  let status: WorkerStatus = 'starting';
  let inFlight = 0;
  let cycles = 0;
  let lastCycleAt: Date | null = null;
  let stopping = false;
  let loopFinished: Promise<void> | null = null;

  /**
   * Read the stop flag through a call, not directly.
   *
   * `shutdown()` sets `stopping` while the loop is parked on an `await`, but
   * TypeScript's control-flow analysis cannot model a mutation from another
   * task: after `while (!stopping)` it narrows the flag to `false` for the
   * whole body and reports the mid-cycle re-check as dead code. The check is
   * load-bearing — without it a cycle that began before shutdown would sleep a
   * full interval before noticing — so the accessor keeps the runtime
   * behaviour and tells the compiler the truth.
   */
  const isStopping = (): boolean => stopping;

  async function runCycle(): Promise<CycleOutcome> {
    inFlight += 1;
    try {
      // STARTUP AND CRASH RECOVERY ARE THE SAME OPERATION. A worker cannot tell
      // whether pending entries were abandoned by a crashed peer or by its own
      // previous life, and it does not need to — reclaiming them is correct
      // either way.
      const recovered = cycles % recoverEvery === 0 ? await deps.recoverPending() : 0;
      const relayed = await deps.drainOutbox();

      cycles += 1;
      lastCycleAt = now();
      const outcome: CycleOutcome = { relayed, recovered };
      deps.onCycle?.(outcome);
      return outcome;
    } finally {
      inFlight -= 1;
    }
  }

  async function loop(): Promise<void> {
    // Recovery runs on the FIRST cycle, before any new work — a restart after a
    // crash must reclaim abandoned entries before it adds to the backlog.
    status = 'ready';

    while (!isStopping()) {
      let didWork = false;
      try {
        const outcome = await runCycle();
        didWork = outcome.relayed > 0 || outcome.recovered > 0;
      } catch (error) {
        // A cycle failure must never kill the loop. The events are still in the
        // outbox — unpublished, and therefore not lost — so the correct
        // response is to back off and try again.
        deps.onError?.(error);
      }

      // Always turn the event loop, whatever `sleep` does — see `tick`.
      await tick();
      if (isStopping()) break;
      await sleep(didWork ? busyMs : idleMs);
    }

    status = 'stopped';
  }

  return {
    start(): Promise<void> {
      if (loopFinished !== null) return loopFinished;
      loopFinished = loop();
      return loopFinished;
    },

    /**
     * Graceful shutdown.
     *
     * `stopping` is set FIRST so no further cycle begins, then the loop's
     * current cycle is awaited. In-flight work finishes: abandoning a cycle
     * mid-publish would leave entries pending that a peer must later reclaim,
     * turning every deploy into a recovery event.
     */
    async shutdown(): Promise<void> {
      if (stopping) {
        if (loopFinished !== null) await loopFinished;
        return;
      }
      stopping = true;
      status = 'draining';
      if (loopFinished !== null) await loopFinished;
      status = 'stopped';
    },

    health(): WorkerHealth {
      return {
        status,
        hostedGroups: deps.hostedGroups,
        inFlight,
        lastCycleAt,
        cyclesCompleted: cycles,
        startedAt,
      };
    },

    runCycle,
  };
}

/**
 * Bind SIGTERM and SIGINT to a graceful shutdown.
 *
 * SIGTERM is what an orchestrator sends before it kills a pod, so the window
 * between it and SIGKILL is exactly the time available to finish in-flight
 * work. A worker that ignores it gets killed mid-publish.
 *
 * Returns a disposer so tests can unbind without leaking listeners.
 */
export function bindShutdownSignals(
  worker: RelayWorker,
  signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
  onSignal?: (signal: NodeJS.Signals) => void,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of signals) {
    const handler = (): void => {
      onSignal?.(signal);
      void worker.shutdown();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return (): void => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}
