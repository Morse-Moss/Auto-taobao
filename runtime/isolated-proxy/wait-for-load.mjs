const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDocumentReady({ readState, timeoutMs = 15_000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await readState(deadline - Date.now());
      if (state === "interactive" || state === "complete") return state;
    } catch {
      // A navigation can replace the execution context between probes.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  return "timeout";
}
