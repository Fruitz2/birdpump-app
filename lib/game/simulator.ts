// Deterministic PumpBird simulator.
// Ported verbatim from PumpBird-game-only/lib/game/simulator.ts so the server
// can replay client tap logs and compute authoritative scores.
//
// IMPORTANT: this file MUST stay byte-identical to the client copy. Any drift
// breaks score validation. If you change physics, change it in both places and
// bump SIMULATOR_VERSION below.

export const SIMULATOR_VERSION = 4;

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
    next.pipeDelay = diff.pipeDelayTicks;
    next.pipes.push(createPipePair(config, state.seed, next.nextPipeId, diff.pipeGap));
    next.nextPipeId += 1;
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
  gapOverride?: number
): PipePair {
  const random = random01(`${seed}:${config.id}:pipe:${id}`);
  const gap = gapOverride ?? config.pipeGap;
  let southY: number;
  let northY: number;

  if (config.pipeModel === "source") {
    const minY = 60;
    const maxY = config.height - config.groundHeight - gap - 60;
    const gapY = minY + random * Math.max(1, maxY - minY);
    southY = gapY - config.pipeHeight;
    northY = gapY + gap;
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

function random01(input: string): number {
  return fnv1a(input) / 0xffffffff;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
