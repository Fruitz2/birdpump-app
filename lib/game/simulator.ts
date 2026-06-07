// Deterministic PumpBird simulator.
// Ported verbatim from PumpBird-game-only/lib/game/simulator.ts so the server
// can replay client tap logs and compute authoritative scores.
//
// IMPORTANT: this file MUST stay byte-identical to the client copy. Any drift
// breaks score validation. If you change physics, change it in both places and
// bump SIMULATOR_VERSION below.

export const SIMULATOR_VERSION = 6;

// Progressive difficulty curve (custom variant only).
// The base config values are the MIDGAME anchor (reached at score 30).
// Below 30: pipes are sparser, gaps are wider, scroll is slower. Above 30 the
// curve continues toward a slightly-tighter endgame at score 60.
// Anchored at three points so each phase can be tuned independently without
// touching the simulator math.
type Diff = { pipeSpeed: number; pipeDelayTicks: number; pipeGap: number };

const EASY: Diff   = { pipeSpeed: 2.55, pipeDelayTicks: 77, pipeGap: 200 };
const HARD: Diff   = { pipeSpeed: 3.40, pipeDelayTicks: 42, pipeGap: 156 };
const RAMP_MID_SCORE = 30;
const RAMP_HARD_SCORE = 60;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function difficultyFor(score: number, config: GameVariantConfig): Diff {
  // forked variant: no progression, keep the static config
  if (config.id !== "custom") {
    return {
      pipeSpeed: config.pipeSpeed,
      pipeDelayTicks: config.pipeDelayTicks,
      pipeGap: config.pipeGap
    };
  }
  const mid: Diff = {
    pipeSpeed: config.pipeSpeed,
    pipeDelayTicks: config.pipeDelayTicks,
    pipeGap: config.pipeGap
  };
  if (score <= 0) return { ...EASY };
  if (score >= RAMP_HARD_SCORE) return { ...HARD };
  if (score <= RAMP_MID_SCORE) {
    const t = score / RAMP_MID_SCORE;
    return {
      pipeSpeed: lerp(EASY.pipeSpeed, mid.pipeSpeed, t),
      pipeDelayTicks: Math.round(lerp(EASY.pipeDelayTicks, mid.pipeDelayTicks, t)),
      pipeGap: Math.round(lerp(EASY.pipeGap, mid.pipeGap, t))
    };
  }
  const t = (score - RAMP_MID_SCORE) / (RAMP_HARD_SCORE - RAMP_MID_SCORE);
  return {
    pipeSpeed: lerp(mid.pipeSpeed, HARD.pipeSpeed, t),
    pipeDelayTicks: Math.round(lerp(mid.pipeDelayTicks, HARD.pipeDelayTicks, t)),
    pipeGap: Math.round(lerp(mid.pipeGap, HARD.pipeGap, t))
  };
}

export type VariantId = "forked" | "custom";

export type GameVariantConfig = {
  id: VariantId;
  label: string;
  subtitle: string;
  width: number;
  height: number;
  groundHeight: number;
  tickMs: number;
  maxTicks: number;
  gravity: number;
  flapVelocity: number;
  jumpCooldownTicks: number;
  pipeDelayTicks: number;
  pipeSpeed: number;
  pipeGap: number;
  pipeWidth: number;
  pipeHeight: number;
  pipeJitter: number;
  pipeModel: "forked" | "source";
  hitboxInset: number;
  ceilingKills: boolean;
  bird: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type BirdState = {
  x: number;
  y: number;
  yVel: number;
  width: number;
  height: number;
  rotation: number;
  dead: boolean;
};

export type PipePair = {
  id: number;
  x: number;
  southY: number;
  northY: number;
  scored: boolean;
};

export type GameState = {
  variant: VariantId;
  seed: string;
  tick: number;
  pipeDelay: number;
  nextPipeId: number;
  jumpCooldown: number;
  score: number;
  gameover: boolean;
  bird: BirdState;
  pipes: PipePair[];
  // Gap-center Y of the most recently spawned pipe. Used by the next spawn to
  // push the new gap AWAY from this one — kills the "tunnel" effect where
  // consecutive pipes have similar Y and the bird feels like it's flying down
  // a hallway instead of dodging pillars. Optional for backwards-compat with
  // older saved states; treated as undefined if absent.
  lastGapY?: number;
};

export type SimulationResult = {
  score: number;
  ticks: number;
  gameover: boolean;
  taps: number[];
  checksum: string;
  finalY: number;
};

export const VARIANT_CONFIGS: Record<VariantId, GameVariantConfig> = {
  forked: {
    id: "forked",
    label: "Forked Circuit",
    subtitle: "CC0 Java FlappyBird port, retuned for PumpBird tickets.",
    width: 500,
    height: 520,
    groundHeight: 80,
    tickMs: 25,
    maxTicks: 7200,
    gravity: 0.5,
    flapVelocity: -10,
    jumpCooldownTicks: 10,
    pipeDelayTicks: 100,
    pipeSpeed: 3,
    pipeGap: 175,
    pipeWidth: 66,
    pipeHeight: 400,
    pipeJitter: 120,
    pipeModel: "forked",
    hitboxInset: 2,
    ceilingKills: false,
    bird: { x: 100, y: 150, width: 45, height: 32 }
  },
  custom: {
    id: "custom",
    label: "Source Drop",
    subtitle: "Port of supplied PumpBird canvas, wrapped in paid terminal.",
    width: 480,
    height: 853,
    groundHeight: 52,
    tickMs: 25,
    maxTicks: 7800,
    // SIMULATOR_VERSION 3 — settled tuning, ~10% slower than v2.
    // Pipe scroll dialed back to give players more reaction time;
    // flap dynamics returned to the gentler v1 baseline; gap widened
    // slightly so the game feels fair, not floaty.
    gravity: 0.45,
    flapVelocity: -8.5,
    jumpCooldownTicks: 1,
    pipeDelayTicks: 55,
    pipeSpeed: 3.0,
    pipeGap: 178,
    pipeWidth: 72,
    pipeHeight: 480,
    pipeJitter: 0,
    pipeModel: "source",
    hitboxInset: 12,
    ceilingKills: true,
    bird: { x: 105.6, y: 358.26, width: 80, height: 80 }
  }
};

export function getVariantConfig(variant: VariantId): GameVariantConfig {
  return VARIANT_CONFIGS[variant] ?? VARIANT_CONFIGS.custom;
}

export function createInitialState(variant: VariantId, seed: string): GameState {
  const config = getVariantConfig(variant);
  return {
    variant,
    seed,
    tick: 0,
    pipeDelay: 0,
    nextPipeId: 0,
    jumpCooldown: 0,
    score: 0,
    gameover: false,
    bird: {
      x: config.bird.x,
      y: config.bird.y,
      yVel: 0,
      width: config.bird.width,
      height: config.bird.height,
      rotation: 0,
      dead: false
    },
    pipes: []
  };
}

export function stepGame(state: GameState, tap: boolean): GameState {
  if (state.gameover) return state;

  const config = getVariantConfig(state.variant);
  const bird: BirdState = { ...state.bird };
  const next: GameState = {
    ...state,
    tick: state.tick + 1,
    jumpCooldown: Math.max(0, state.jumpCooldown - 1),
    pipeDelay: state.pipeDelay - 1,
    bird,
    pipes: state.pipes.map((pipe) => ({ ...pipe }))
  };

  if (tap && next.jumpCooldown <= 0 && !bird.dead) {
    bird.yVel = config.flapVelocity;
    next.jumpCooldown = config.jumpCooldownTicks;
  }

  bird.yVel += config.gravity;
  bird.y += bird.yVel;
  bird.rotation = Math.min(Math.PI / 2, ((90 * (bird.yVel + 20)) / 20 - 90) * (Math.PI / 180));

  // Difficulty ramps with score. Pipe spawn delay + scroll speed + gap height
  // all interpolate. New pipes use the gap height current at SPAWN TIME — once
  // a pipe exists it keeps its own gap; the scroll speed it moves at is the
  // live value so a long-lived run smoothly accelerates.
  const diff = difficultyFor(next.score, config);

  if (next.pipeDelay < 0) {
    const newPipe = createPipePair(
      config,
      state.seed,
      next.nextPipeId,
      diff.pipeGap,
      state.lastGapY
    );
    next.pipes.push(newPipe);
    next.lastGapY = newPipe.southY + config.pipeHeight + diff.pipeGap / 2;
    next.nextPipeId += 1;
    // Variable spawn delay for "wave" feel — sometimes 65% of base
    // (clustered pipes), sometimes 135% (a breather). Deterministic
    // per-pipe-id so server replay matches.
    const delayRandom = random01(`${state.seed}:${config.id}:delay:${next.nextPipeId}`);
    const variance = 0.65 + delayRandom * 0.7;
    next.pipeDelay = Math.round(diff.pipeDelayTicks * variance);
  }

  next.pipes = next.pipes
    .map((pipe) => ({ ...pipe, x: pipe.x - diff.pipeSpeed }))
    .filter((pipe) => pipe.x + config.pipeWidth >= -4);

  for (const pipe of next.pipes) {
    if (pipeCollides(pipe, bird, config)) {
      next.gameover = true;
      bird.dead = true;
      break;
    }
    if (!pipe.scored && pipe.x <= bird.x) {
      pipe.scored = true;
      next.score += 1;
    }
  }

  if (config.ceilingKills && bird.y <= 0) {
    next.gameover = true;
    bird.dead = true;
    bird.y = 0;
  }

  if (bird.y + bird.height > config.height - config.groundHeight) {
    next.gameover = true;
    bird.dead = true;
    bird.y = config.height - config.groundHeight - bird.height;
  }

  return next;
}

export function simulateRun(input: {
  variant: VariantId;
  seed: string;
  taps: number[];
  maxTicks?: number;
}): SimulationResult {
  const config = getVariantConfig(input.variant);
  const taps = normalizeTaps(input.taps, input.maxTicks ?? config.maxTicks);
  const tapSet = new Set(taps);
  let state = createInitialState(input.variant, input.seed);

  while (!state.gameover && state.tick < (input.maxTicks ?? config.maxTicks)) {
    state = stepGame(state, tapSet.has(state.tick));
  }

  return {
    score: state.score,
    ticks: state.tick,
    gameover: state.gameover,
    taps,
    checksum: hashTapLog(input.variant, input.seed, taps, state.score, state.tick),
    finalY: Number(state.bird.y.toFixed(3))
  };
}

export function normalizeTaps(taps: number[], maxTick: number): number[] {
  return Array.from(
    new Set(
      taps
        .filter((tick) => Number.isFinite(tick))
        .map((tick) => Math.trunc(tick))
        .filter((tick) => tick >= 0 && tick <= maxTick)
    )
  ).sort((a, b) => a - b);
}

// Multi-life seed derivation. Each life inside a paid-pack ticket gets a
// distinct deterministic seed so the pipe sequence is different every game.
// Server-side replay reproduces the same sequence given (ticketSeed, lifeIndex).
export function seedForLife(ticketSeed: string, lifeIndex: number): string {
  if (!lifeIndex) return ticketSeed;
  return `${ticketSeed}#life-${lifeIndex}`;
}

export function hashTapLog(
  variant: VariantId,
  seed: string,
  taps: number[],
  score: number,
  ticks: number
): string {
  return fnv1a(`${variant}:${seed}:${score}:${ticks}:${taps.join(",")}`)
    .toString(16)
    .padStart(8, "0");
}

function createPipePair(
  config: GameVariantConfig,
  seed: string,
  id: number,
  gapOverride?: number,
  prevGapCenterY?: number
): PipePair {
  const random = random01(`${seed}:${config.id}:pipe:${id}`);
  const gap = gapOverride ?? config.pipeGap;
  let southY: number;
  let northY: number;

  if (config.pipeModel === "source") {
    // Defensive: clamp gap so we can never accidentally produce a wall.
    const safeGap = Math.max(120, Math.min(260, gap));
    const minY = 60;
    const maxY = config.height - config.groundHeight - safeGap - 60;
    let gapY = minY + random * Math.max(1, maxY - minY);

    // Anti-clustering: if the previous pipe's gap center is too close to this
    // one's candidate position, reflect across the playfield center so the
    // bird actually has to move up/down between pipes. Range threshold is
    // ~30% of playable Y so two pipes in a row never sit on top of each other.
    if (typeof prevGapCenterY === "number") {
      const candidateCenter = gapY + safeGap / 2;
      const playableRange = maxY - minY + safeGap;
      const minSeparation = playableRange * 0.30;
      if (Math.abs(candidateCenter - prevGapCenterY) < minSeparation) {
        const playCenter = (minY + safeGap / 2 + maxY + safeGap / 2) / 2;
        const reflectedCenter = playCenter * 2 - candidateCenter;
        gapY = reflectedCenter - safeGap / 2;
        // Clamp back into legal range
        gapY = Math.max(minY, Math.min(maxY, gapY));
      }
    }

    southY = gapY - config.pipeHeight;
    northY = gapY + safeGap;
  } else {
    southY = -(random * config.pipeJitter) - config.pipeHeight / 2;
    northY = southY + config.pipeHeight + gap;
  }

  return { id, x: config.width + 2, southY, northY, scored: false };
}

function pipeCollides(pipe: PipePair, bird: BirdState, config: GameVariantConfig): boolean {
  const margin = config.hitboxInset;
  const birdBox = {
    x: bird.x + margin,
    y: bird.y + margin,
    width: Math.max(1, bird.width - margin * 2),
    height: Math.max(1, bird.height - margin * 2)
  };
  const overlapsX = birdBox.x + birdBox.width > pipe.x && birdBox.x < pipe.x + config.pipeWidth;
  if (!overlapsX) return false;

  const topHit = birdBox.y < pipe.southY + config.pipeHeight;
  const bottomHit = birdBox.y + birdBox.height > pipe.northY;
  return topHit || bottomHit;
}

// FNV-1a alone has weak avalanche on sequential keys like "pipe:0", "pipe:1"
// — the resulting gap positions clustered too tightly. We pass the FNV output
// through the Murmur3 finalizer (xor-shift + multiply) to get a properly
// uniform distribution across [0, 1). Still 100% deterministic.
function random01(input: string): number {
  let h = fnv1a(input);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
