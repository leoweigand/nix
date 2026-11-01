export interface Check {
  name: string;
  url: string;
  expectedStatus: number;
  verifies: string;
  issuer?: string;
}

export async function getLabStatus(checks: Check[], timeoutMs = 3000) {
  const services = await Promise.all(
    checks.map(async (check) => {
      const started = performance.now();
      let status: "healthy" | "unhealthy" | "unreachable" = "unreachable";
      let httpStatus: number | null = null;
      let reason: string | null = null;
      try {
        const response = await fetch(check.url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
          headers: { Accept: "application/json" },
        });
        httpStatus = response.status;
        status =
          response.status === check.expectedStatus ? "healthy" : "unhealthy";
        if (status === "unhealthy") reason = "unexpected_http_status";
        if (check.issuer && status === "healthy") {
          try {
            const data = (await response.json()) as Record<string, unknown>;
            if (
              data.issuer !== check.issuer ||
              typeof data.token_endpoint !== "string"
            ) {
              status = "unhealthy";
              reason = "invalid_discovery_document";
            }
          } catch {
            status = "unhealthy";
            reason = "invalid_discovery_document";
          }
        } else {
          await response.body?.cancel();
        }
      } catch (error) {
        reason =
          error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name)
            ? "timeout"
            : "connection_failed";
      }
      return {
        name: check.name,
        status,
        httpStatus,
        reason,
        durationMs: Math.round(performance.now() - started),
        verifies: check.verifies,
      };
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    healthy: services.every((service) => service.status === "healthy"),
    services,
  };
}
