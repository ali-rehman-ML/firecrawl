import { describe, expect, it } from "vitest";
import {
  HARNESS_SERVICES,
  InvalidHarnessServiceError,
  parseHarnessHeapLimits,
  selectHarnessServices,
  withHeapLimit,
} from "./harness-services";

const RABBIT = "amqp://rabbitmq:5672";

describe("selectHarnessServices", () => {
  describe("full stack", () => {
    it("starts every service when the backing services are all present", () => {
      const { enabled, skipped } = selectHarnessServices({
        nuqBackend: "pg",
        rabbitMqUrl: RABBIT,
        useDbAuthentication: true,
      });

      expect([...enabled].sort()).toEqual([...HARNESS_SERVICES].sort());
      expect(skipped).toEqual([]);
    });

    it("drops the index worker without database authentication", () => {
      const { enabled, skipped } = selectHarnessServices({
        nuqBackend: "pg",
        rabbitMqUrl: RABBIT,
        useDbAuthentication: false,
      });

      expect(enabled.has("index-worker")).toBe(false);
      expect(skipped.map(s => s.service)).toEqual(["index-worker"]);
    });

    it("drops the prefetch and reconciler workers on the FDB backend", () => {
      const { enabled } = selectHarnessServices({
        nuqBackend: "fdb",
        rabbitMqUrl: RABBIT,
        useDbAuthentication: true,
      });

      expect(enabled.has("nuq-prefetch-worker")).toBe(false);
      expect(enabled.has("nuq-reconciler-worker")).toBe(false);
      expect(enabled.has("nuq-worker")).toBe(true);
    });
  });

  describe("without RabbitMQ", () => {
    // The extract worker exits on startup and the prefetch worker strands jobs
    // it can't publish, so neither may be started when there is no broker.
    it("drops the extract and prefetch workers", () => {
      const { enabled, skipped } = selectHarnessServices({
        nuqBackend: "pg",
        rabbitMqUrl: undefined,
        useDbAuthentication: false,
      });

      expect(enabled.has("extract-worker")).toBe(false);
      expect(enabled.has("nuq-prefetch-worker")).toBe(false);
      expect(skipped.map(s => s.service).sort()).toEqual([
        "extract-worker",
        "index-worker",
        "nuq-prefetch-worker",
      ]);
    });

    it("keeps the API, queue worker, NuQ worker and reconciler", () => {
      const { enabled } = selectHarnessServices({ nuqBackend: "pg" });

      expect([...enabled].sort()).toEqual([
        "api",
        "nuq-reconciler-worker",
        "nuq-worker",
        "worker",
      ]);
    });

    it("explains why each service was skipped", () => {
      const { skipped } = selectHarnessServices({ nuqBackend: "pg" });

      for (const { reason } of skipped) {
        expect(reason).not.toEqual("");
      }
      expect(
        skipped.find(s => s.service === "extract-worker")?.reason,
      ).toContain("NUQ_RABBITMQ_URL");
    });
  });

  describe("HARNESS_SERVICES allowlist", () => {
    it("starts only the requested services", () => {
      const { enabled } = selectHarnessServices({
        requested: ["api", "nuq-worker"],
        nuqBackend: "pg",
        rabbitMqUrl: RABBIT,
        useDbAuthentication: true,
      });

      expect([...enabled].sort()).toEqual(["api", "nuq-worker"]);
    });

    it("still refuses a requested service whose dependency is missing", () => {
      const { enabled, skipped } = selectHarnessServices({
        requested: ["api", "extract-worker"],
        nuqBackend: "pg",
      });

      expect([...enabled]).toEqual(["api"]);
      expect(skipped).toEqual([
        {
          service: "extract-worker",
          reason:
            "NUQ_RABBITMQ_URL is not configured (/v2/extract is unavailable)",
        },
      ]);
    });

    it("treats an empty list as unset so the stack does not start empty", () => {
      const { enabled } = selectHarnessServices({
        requested: [],
        nuqBackend: "pg",
        rabbitMqUrl: RABBIT,
        useDbAuthentication: true,
      });

      expect(enabled.size).toBe(HARNESS_SERVICES.length);
    });

    it("throws on an unknown service rather than silently dropping it", () => {
      expect(() =>
        selectHarnessServices({ requested: ["api", "nuq-workers"] }),
      ).toThrow(InvalidHarnessServiceError);
    });
  });
});

describe("parseHarnessHeapLimits", () => {
  it("parses per-service megabyte ceilings", () => {
    const limits = parseHarnessHeapLimits(["api=448", "nuq-worker=288"]);

    expect(limits.get("api")).toBe(448);
    expect(limits.get("nuq-worker")).toBe(288);
    expect(limits.get("worker")).toBeUndefined();
  });

  it("treats unset and empty entries as no limits", () => {
    expect(parseHarnessHeapLimits().size).toBe(0);
    expect(parseHarnessHeapLimits([""]).size).toBe(0);
  });

  it("rejects an unknown service rather than ignoring the entry", () => {
    expect(() => parseHarnessHeapLimits(["ap=448"])).toThrow(
      InvalidHarnessServiceError,
    );
  });

  it.each(["api", "api=", "api=0", "api=-1", "api=448.5", "api=lots"])(
    "rejects malformed entry %j",
    entry => {
      expect(() => parseHarnessHeapLimits([entry])).toThrow();
    },
  );
});

describe("withHeapLimit", () => {
  it("leaves NODE_OPTIONS alone when the service has no limit", () => {
    expect(withHeapLimit("--enable-source-maps", undefined)).toBe(
      "--enable-source-maps",
    );
    expect(withHeapLimit(undefined, undefined)).toBeUndefined();
  });

  // V8 honours the last occurrence, but two conflicting flags in `ps` output
  // misrepresent which limit is actually in force.
  it("replaces an inherited limit instead of appending a second one", () => {
    const result = withHeapLimit(
      "--max-old-space-size=256 --enable-source-maps",
      448,
    );

    expect(result).toBe("--enable-source-maps --max-old-space-size=448");
    expect(result!.match(/--max-old-space-size/g)).toHaveLength(1);
  });

  it("sets the limit when nothing was inherited", () => {
    expect(withHeapLimit(undefined, 288)).toBe("--max-old-space-size=288");
    expect(withHeapLimit("", 288)).toBe("--max-old-space-size=288");
  });
});
