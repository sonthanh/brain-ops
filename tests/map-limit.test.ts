import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/lib/map-limit.ts";

describe("mapLimit — bounded parallel map for Gmail fetches", () => {
  test("keeps input order in the output", async () => {
    const out = await mapLimit([30, 10, 20], 3, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  test("never runs more than `limit` tasks at once", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 5, async () => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running--;
    });
    expect(peak).toBe(5);
  });

  test("empty input → empty output", async () => {
    expect(await mapLimit([], 5, async (x: number) => x)).toEqual([]);
  });
});
