import { drainMetaEventOutbox, getInFlightDrain, REQUEST_TIMEOUT_MS, resolveMetaWorkerConfig } from "./metaCapi";
import { reconcileMetaEvents } from "./metaReconciler";

// In-process drain + reconciler wrapper: ~60s tick, try/catch around every tick,
// single-flight, cooperative stop on SIGTERM. Never lets a rejection escape.

const TICK_MS = 60_000;
const RECONCILE_EVERY_MS = 10 * 60 * 1000;

let started = false;
let stopped = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let lastReconcileAt = 0;

function scheduleNext(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    timer = null;
    inFlight = tick();
  }, TICK_MS);
}

async function tick(): Promise<void> {
  if (stopped) return;
  if (running) {
    scheduleNext();
    return;
  }
  running = true;
  try {
    const resolved = resolveMetaWorkerConfig();
    if (resolved.ok) {
      if (Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS) {
        lastReconcileAt = Date.now();
        try {
          const rec = await reconcileMetaEvents();
          if (rec.purchases + rec.registrations + rec.activations > 0) {
            console.log(`[metaDrainWorker] reconciled ${JSON.stringify(rec)}`);
          }
        } catch (err) {
          console.error("[metaDrainWorker] reconcile failed:", err instanceof Error ? err.message : "unknown");
        }
      }
      const summary = await drainMetaEventOutbox(resolved.config, () => stopped);
      if (summary.claimed > 0) console.log(`[metaDrainWorker] drain ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error("[metaDrainWorker] tick failed:", err instanceof Error ? err.message : "unknown");
  } finally {
    running = false;
  }
  scheduleNext();
}

export function startMetaDrainWorker(): void {
  if (process.env.META_CAPI_ENABLED !== "true") {
    console.log("[metaDrainWorker] disabled - META_CAPI_ENABLED not true");
    return;
  }
  const resolved = resolveMetaWorkerConfig();
  if (!resolved.ok) {
    console.error(`[metaDrainWorker] not starting - missing/invalid config: ${resolved.missing.join(", ")}`);
    return;
  }
  if (started) return;
  started = true;
  stopped = false;
  inFlight = tick();
}

export async function stopMetaDrainWorker(): Promise<void> {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const pending = running ? inFlight : getInFlightDrain();
  if (pending) {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS + 2_000)),
    ]);
  }
  started = false;
  running = false;
}
