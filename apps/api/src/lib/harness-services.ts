/**
 * Decides which child processes the harness starts.
 *
 * The full stack runs an API process, a queue worker, N NuQ workers, a
 * prefetch worker, a reconciler and an extract worker — roughly nine Node
 * processes, each with its own heap. That is fine on a large box and fatal on
 * a 2 vCPU / 2 GB one, so the set is selectable via `HARNESS_SERVICES`.
 *
 * Two of the services also have hard dependencies that used to be implicit:
 * the extract worker connects to RabbitMQ at startup and exits when it can't,
 * and the prefetch worker's only job is to move rows into RabbitMQ. Running
 * either without a broker is worse than not running it at all, so they are
 * filtered out here rather than left to crash or silently strand jobs.
 */

export const HARNESS_SERVICES = [
  "api",
  "worker",
  "nuq-worker",
  "nuq-prefetch-worker",
  "nuq-reconciler-worker",
  "extract-worker",
  "index-worker",
] as const;

export type HarnessService = (typeof HARNESS_SERVICES)[number];

interface HarnessServiceInput {
  /** Parsed `HARNESS_SERVICES` allowlist. Empty/undefined means "all of them". */
  requested?: string[];
  /** `NUQ_BACKEND`. The FDB worker does its own prefetching and reconciling. */
  nuqBackend?: "pg" | "fdb";
  /** `NUQ_RABBITMQ_URL`. Absent means NuQ pulls jobs straight from Postgres. */
  rabbitMqUrl?: string;
  /** `USE_DB_AUTHENTICATION`. The index worker has nothing to index without it. */
  useDbAuthentication?: boolean;
}

interface HarnessServiceSelection {
  enabled: Set<HarnessService>;
  /** Services that were asked for (explicitly or by default) but can't run. */
  skipped: { service: HarnessService; reason: string }[];
}

export class InvalidHarnessServiceError extends Error {
  constructor(name: string) {
    super(
      `Unknown service ${JSON.stringify(name)} in HARNESS_SERVICES. ` +
        `Valid services: ${HARNESS_SERVICES.join(", ")}`,
    );
    this.name = "InvalidHarnessServiceError";
  }
}

function isHarnessService(name: string): name is HarnessService {
  return (HARNESS_SERVICES as readonly string[]).includes(name);
}

/**
 * @throws {InvalidHarnessServiceError} if `requested` names a service that
 * does not exist — a typo there would silently drop a worker otherwise.
 */
export function selectHarnessServices(
  input: HarnessServiceInput = {},
): HarnessServiceSelection {
  const { requested, nuqBackend, rabbitMqUrl, useDbAuthentication } = input;

  let candidates: HarnessService[];
  if (requested && requested.length > 0) {
    for (const name of requested) {
      if (!isHarnessService(name)) throw new InvalidHarnessServiceError(name);
    }
    candidates = HARNESS_SERVICES.filter(service =>
      requested.includes(service),
    );
  } else {
    candidates = [...HARNESS_SERVICES];
  }

  const enabled = new Set<HarnessService>();
  const skipped: HarnessServiceSelection["skipped"] = [];

  for (const service of candidates) {
    const reason = disabledReason(service, {
      nuqBackend,
      rabbitMqUrl,
      useDbAuthentication,
    });
    if (reason === null) enabled.add(service);
    else skipped.push({ service, reason });
  }

  return { enabled, skipped };
}

function disabledReason(
  service: HarnessService,
  input: Omit<HarnessServiceInput, "requested">,
): string | null {
  const { nuqBackend, rabbitMqUrl, useDbAuthentication } = input;
  const hasRabbitMq = !!rabbitMqUrl;
  const isFdb = nuqBackend === "fdb";

  switch (service) {
    case "extract-worker":
      // consumeExtractJobs() connects to RabbitMQ on startup; without a broker
      // the process throws and takes the whole harness down with it.
      return hasRabbitMq
        ? null
        : "NUQ_RABBITMQ_URL is not configured (/v2/extract is unavailable)";

    case "nuq-prefetch-worker":
      if (isFdb) return "the FoundationDB backend prefetches in-worker";
      // prefetchJobs() flips rows to 'active' and publishes them to RabbitMQ.
      // With no broker the publish is dropped and the job is stranded until
      // the lock reaper releases it a minute later; NuQ workers already fall
      // back to polling Postgres directly, so skipping this is the fast path.
      return hasRabbitMq
        ? null
        : "NUQ_RABBITMQ_URL is not configured (NuQ workers poll Postgres directly)";

    case "nuq-reconciler-worker":
      return isFdb ? "the FoundationDB backend reconciles in-worker" : null;

    case "index-worker":
      return useDbAuthentication
        ? null
        : "USE_DB_AUTHENTICATION is not enabled";

    default:
      return null;
  }
}

/**
 * Per-process V8 heap ceilings, parsed from `HARNESS_HEAP_MB` entries shaped
 * `service=MB` (e.g. `api=448,nuq-worker=288`).
 *
 * A single global `NODE_OPTIONS=--max-old-space-size=N` is the wrong shape for
 * this stack: the api process holds every in-flight request and needs the most
 * headroom, while the queue worker is nearly idle. Sizing them together either
 * starves api under concurrent requests -- it aborts with "Reached heap limit",
 * taking the whole harness down with it -- or wastes the budget on processes
 * that will never use it.
 *
 * @throws {InvalidHarnessServiceError} on an unknown service name.
 */
export function parseHarnessHeapLimits(
  entries?: string[],
): Map<HarnessService, number> {
  const limits = new Map<HarnessService, number>();
  for (const entry of entries ?? []) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.lastIndexOf("=");
    if (separator === -1) {
      throw new Error(
        `Malformed HARNESS_HEAP_MB entry ${JSON.stringify(entry)}; expected "service=MB"`,
      );
    }

    const name = trimmed.slice(0, separator).trim();
    const rawMb = trimmed.slice(separator + 1).trim();
    if (!isHarnessService(name)) throw new InvalidHarnessServiceError(name);

    const mb = Number(rawMb);
    if (!Number.isInteger(mb) || mb <= 0) {
      throw new Error(
        `Invalid heap size ${JSON.stringify(rawMb)} for ${name} in HARNESS_HEAP_MB; expected a positive integer of megabytes`,
      );
    }

    limits.set(name, mb);
  }
  return limits;
}

/**
 * Builds the child's NODE_OPTIONS, replacing any inherited
 * `--max-old-space-size` rather than appending a second one. V8 does take the
 * last occurrence, but leaving both in makes `ps` output actively misleading
 * about which limit is in force.
 */
export function withHeapLimit(
  nodeOptions: string | undefined,
  mb: number | undefined,
): string | undefined {
  if (mb === undefined) return nodeOptions;

  const kept = (nodeOptions ?? "")
    .split(/\s+/)
    .filter(token => token !== "" && !token.startsWith("--max-old-space-size"));

  return [...kept, `--max-old-space-size=${mb}`].join(" ");
}
