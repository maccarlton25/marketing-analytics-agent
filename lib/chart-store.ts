/**
 * In-memory chart store. executeAnalysis writes charts here (keyed by ID),
 * the UI fetches them via /api/charts/[id]. Avoids putting base64 in
 * tool results which bloat the model's context window.
 *
 * Charts expire after 10 minutes to avoid unbounded memory growth.
 */

const TTL_MS = 10 * 60 * 1000;

interface StoredChart {
  base64: string;
  createdAt: number;
}

const store = new Map<string, StoredChart>();

export const chartStore = {
  set(id: string, base64: string) {
    store.set(id, { base64, createdAt: Date.now() });
  },

  get(id: string): string | undefined {
    const entry = store.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > TTL_MS) {
      store.delete(id);
      return undefined;
    }
    return entry.base64;
  },

  /** Store multiple charts at once, returns their IDs. */
  setAll(charts: { id: string; base64: string }[]): string[] {
    for (const c of charts) {
      this.set(c.id, c.base64);
    }
    return charts.map((c) => c.id);
  },
};
