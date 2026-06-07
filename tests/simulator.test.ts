import { describe, expect, it } from "vitest";
import {
  createInitialState,
  simulateRun,
  stepGame,
  hashTapLog
} from "@/lib/game/simulator";

describe("PumpBird simulator", () => {
  it("starts the bird at the variant-configured position", () => {
    const state = createInitialState("custom", "test-seed");
    expect(state.tick).toBe(0);
    expect(state.bird.dead).toBe(false);
    expect(state.bird.x).toBeGreaterThan(0);
    expect(state.bird.y).toBeGreaterThan(0);
  });

  it("kills the bird on the ground (no taps, custom variant)", () => {
    const result = simulateRun({ variant: "custom", seed: "ground", taps: [] });
    expect(result.gameover).toBe(true);
    expect(result.score).toBe(0);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThan(200);
  });

  it("kills the bird on the ground (no taps, forked variant)", () => {
    const result = simulateRun({ variant: "forked", seed: "ground", taps: [] });
    expect(result.gameover).toBe(true);
    expect(result.score).toBe(0);
  });

  it("is deterministic — same seed + taps -> same score + checksum", () => {
    const taps = [10, 25, 40, 55, 70, 85, 100, 115, 130];
    const a = simulateRun({ variant: "custom", seed: "det", taps });
    const b = simulateRun({ variant: "custom", seed: "det", taps });
    expect(a.score).toBe(b.score);
    expect(a.ticks).toBe(b.ticks);
    expect(a.checksum).toBe(b.checksum);
  });

  it("step game advances tick + applies gravity", () => {
    const s0 = createInitialState("custom", "x");
    const s1 = stepGame(s0, false);
    expect(s1.tick).toBe(1);
    expect(s1.bird.yVel).toBeGreaterThan(s0.bird.yVel);
  });

  it("hashTapLog is stable", () => {
    const c = hashTapLog("custom", "seed", [1, 2, 3], 5, 100);
    expect(c).toMatch(/^[0-9a-f]{8}$/u);
  });
});
