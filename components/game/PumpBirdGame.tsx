"use client";

// PumpBird Game — deterministic, smooth, anti-cheat-friendly.
//
// Why two canvases:
//   - `bgCanvas` holds the static background (sky gradient, stars, city silhouette,
//     ambient signs). Drawn ONCE on mount/resize. Zero per-frame cost.
//   - `gameCanvas` is the dynamic layer (bird, pipes, particles, HUD). Cleared
//     and redrawn each frame. The original single-canvas version was laggy
//     because shadowBlur + gradient creation + 60 stars + city silhouette
//     re-ran on every rAF tick — that's what we fix here.
//
// Why fixed-timestep + interpolation:
//   - Physics runs in 25ms ticks via the deterministic simulator
//     (lib/game/simulator.ts). Server replays the same tick log to verify
//     scores — that's the anti-cheat foundation.
//   - Render runs at requestAnimationFrame (60-144Hz). We interpolate bird
//     position between the previous and next state to make the motion smooth
//     even at non-multiple-of-40Hz displays.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createInitialState,
  stepGame,
  getVariantConfig,
  type GameState,
  type VariantId
} from "@/lib/game/simulator";

export type GameMode = "paid" | "fun";

export type GameResult = {
  score: number;
  ticks: number;
  taps: number[];
};

type Props = {
  mode: GameMode;
  seed: string;
  variant?: VariantId;
  width?: number;       // px — defaults to viewport-based
  height?: number;
  onComplete: (result: GameResult) => void;
  onExit?: () => void;
  // When provided, tapping the canvas after death triggers this (used by
  // /play-fun and the landing-cabinet free-play to start a fresh run on click).
  onRestart?: () => void;
  // Skip the START GAME overlay and begin immediately when the sprite is ready.
  // Used when the user clicks the landing cabinet — they already expressed
  // intent to play, no second click needed.
  autoStart?: boolean;
};

type Particle = {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dec: number;
  r: number;
  color: string;
};

const TICK_MS = 25;          // matches simulator tickMs for custom variant
const TARGET_ASPECT = 480 / 853; // 9:16-ish, matches simulator
const MAX_W = 540;
const MAX_H = 960;
const PARTICLE_POOL = 200;
const IDLE_SPRITE_URL = "/assets/game/pump-bird-idle.png";
const DEAD_SPRITE_URL = "/assets/game/pump-bird-dead.png";

export function PumpBirdGame({
  mode,
  seed,
  variant = "custom",
  width,
  height,
  onComplete,
  onExit,
  onRestart,
  autoStart
}: Props) {
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const stateRef = useRef<GameState>(createInitialState(variant, seed));
  const prevStateRef = useRef<GameState>(stateRef.current);
  const tapsRef = useRef<number[]>([]);
  const pendingTapRef = useRef(false);
  const phaseRef = useRef<"start" | "playing" | "dead">("start");
  const startTimeRef = useRef(0);
  const lastFrameRef = useRef(0);
  const accumulatorRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Size lives in state so the wrap div re-renders with correct dimensions
  // once we measure the viewport. (Initial render before measurement has w=0.)
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const idleSpriteRef = useRef<HTMLImageElement | HTMLCanvasElement | null>(null);
  const deadSpriteRef = useRef<HTMLImageElement | HTMLCanvasElement | null>(null);
  const spriteReadyRef = useRef(false);
  const particlesRef = useRef<Particle[]>(
    Array.from({ length: PARTICLE_POOL }, () => ({
      alive: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      dec: 0,
      r: 0,
      color: "#00ff41"
    }))
  );
  const pipeSpriteRef = useRef<HTMLCanvasElement | null>(null);

  const [phase, setPhase] = useState<"start" | "playing" | "dead">("start");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    try {
      return parseInt(window.localStorage.getItem("pumpBirdBest") ?? "0", 10) || 0;
    } catch {
      return 0;
    }
  });

  // Load idle + dead sprites with a procedural fallback so the game NEVER
  // shows a blank or boxed bird.
  useEffect(() => {
    function buildFallback(palette: "idle" | "dead"): HTMLCanvasElement {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const g = c.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      const body = palette === "dead" ? "#c92a6a" : "#46c41d";
      const bodyDark = palette === "dead" ? "#7a1438" : "#3aa017";
      g.fillStyle = bodyDark;
      g.beginPath();
      g.ellipse(30, 34, 26, 22, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = body;
      g.beginPath();
      g.ellipse(30, 30, 24, 20, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(38, 20, 9, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(52, 20, 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#000";
      g.beginPath();
      g.arc(40, 22, palette === "dead" ? 2 : 3.5, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(53, 22, palette === "dead" ? 2 : 3.5, 0, Math.PI * 2);
      g.fill();
      return c;
    }

    function loadOne(
      url: string,
      ref: React.MutableRefObject<HTMLImageElement | HTMLCanvasElement | null>,
      fallback: HTMLCanvasElement
    ) {
      const img = new Image();
      img.onload = () => {
        ref.current = img;
        spriteReadyRef.current = true;
      };
      img.onerror = () => {
        ref.current = fallback;
        spriteReadyRef.current = true;
      };
      img.src = url;
    }

    loadOne(IDLE_SPRITE_URL, idleSpriteRef, buildFallback("idle"));
    loadOne(DEAD_SPRITE_URL, deadSpriteRef, buildFallback("dead"));
  }, []);

  // Compute size from container + viewport
  const computeSize = useCallback(() => {
    const ww = width ?? containerRef.current?.clientWidth ?? window.innerWidth;
    const wh = height ?? containerRef.current?.clientHeight ?? window.innerHeight;
    let w: number;
    let h: number;
    if (ww / wh < TARGET_ASPECT) {
      w = ww;
      h = ww / TARGET_ASPECT;
    } else {
      h = wh;
      w = wh * TARGET_ASPECT;
    }
    w = Math.min(w, MAX_W);
    h = Math.min(h, MAX_H);
    return { w: Math.floor(w), h: Math.floor(h) };
  }, [width, height]);

  // Pre-render the background to bgCanvas. Runs once on mount + every resize.
  const renderBg = useCallback((w: number, h: number) => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const config = getVariantConfig(variant);
    const groundH = config.groundHeight;

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#010801");
    sky.addColorStop(0.6, "#020d02");
    sky.addColorStop(1, "#030a03");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = "rgba(0,255,65,0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Stars (deterministic from seed so they don't flicker on resize)
    const rng = mulberry32(stringHash(seed));
    for (let i = 0; i < 60; i += 1) {
      const sx = rng() * w;
      const sy = rng() * (h - groundH);
      const sz = rng() < 0.3 ? 2 : 1;
      const alpha = 0.3 + 0.4 * rng();
      ctx.fillStyle = `rgba(0,255,65,${alpha})`;
      ctx.fillRect(sx, sy, sz, sz);
    }

    // Moon
    const mx = w * 0.72;
    const my = h * 0.1;
    ctx.save();
    ctx.shadowColor = "#00ff41";
    ctx.shadowBlur = 20;
    ctx.strokeStyle = "#1aff6e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(26,255,110,0.08)";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // City silhouette
    const sc = w / 480;
    const by = h - groundH;
    const buildings: Array<[number, number, number]> = [
      [0, 30, 60], [28, 20, 90], [46, 35, 50], [79, 25, 110], [102, 30, 70],
      [130, 18, 80], [146, 40, 55], [184, 22, 95], [204, 30, 65], [232, 28, 100],
      [258, 20, 75], [276, 35, 60], [309, 25, 85], [332, 30, 55], [360, 22, 90],
      [380, 40, 70], [418, 28, 65], [444, 20, 80], [462, 18, 55]
    ];
    for (let i = 0; i < buildings.length; i += 1) {
      const [bx, bw, bhRaw] = buildings[i];
      ctx.fillStyle = "#0a1a0a";
      const bh = bhRaw * sc * 0.9;
      ctx.fillRect(bx * sc, by - bh, bw * sc, bh);
      ctx.fillStyle = "rgba(0,255,65,0.13)";
      for (let wy = 4; wy < bhRaw * 0.9 - 6; wy += 10) {
        for (let wx = 4; wx < bw - 5; wx += 8) {
          if ((i * 7 + wx + wy) % 3 !== 0) {
            ctx.fillRect((bx + wx) * sc, by - bh + wy * sc, 4 * sc, 4 * sc);
          }
        }
      }
    }

    // Ambient signs
    const signs = [
      { t: "WAGMI",      x: w * 0.7,  y: h * 0.16, c: "#ff2d78", s: 6 },
      { t: "TO THE MOON", x: w * 0.6,  y: h * 0.5,  c: "#00ff41", s: 5 },
      { t: "BUY THE DIP", x: w * 0.58, y: h * 0.7,  c: "#ff2d78", s: 5 },
      { t: "LFG",        x: w * 0.74, y: h * 0.6,  c: "#00ff41", s: 7 },
      { t: "PUMP",       x: w * 0.05, y: h * 0.62, c: "#ff2d78", s: 8 },
      { t: "$PUMPBIRD",  x: w * 0.05, y: h * 0.77, c: "#00ff41", s: 6 },
      { t: "GM",         x: w * 0.37, y: h * 0.8,  c: "#00ff41", s: 7 }
    ];
    for (const sg of signs) {
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.font = `${sg.s}px 'Press Start 2P', monospace`;
      ctx.textAlign = "left";
      ctx.fillStyle = sg.c;
      ctx.fillText(sg.t, sg.x, sg.y + 2);
      ctx.restore();
    }

    // Ground
    const gg = ctx.createLinearGradient(0, by, 0, h);
    gg.addColorStop(0, "#1aff6e");
    gg.addColorStop(0.08, "#0d8040");
    gg.addColorStop(1, "#041a0a");
    ctx.fillStyle = gg;
    ctx.fillRect(0, by, w, groundH);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    for (let i = 0; i < w; i += 20) ctx.fillRect(i, by, 10, 8);
    ctx.strokeStyle = "#39ff14";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, by);
    ctx.lineTo(w, by);
    ctx.stroke();
  }, [seed, variant]);

  // Build the cached pipe sprite — one tall pipe segment with neon edges.
  const buildPipeSprite = useCallback((w: number, h: number) => {
    const config = getVariantConfig(variant);
    const pipeW = config.pipeWidth;
    const c = document.createElement("canvas");
    c.width = pipeW + 16; // overflow for the cap lip
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const g = ctx.createLinearGradient(0, 0, pipeW, 0);
    g.addColorStop(0, "#0a4020");
    g.addColorStop(0.2, "#1aff6e");
    g.addColorStop(0.5, "#39ff14");
    g.addColorStop(0.8, "#1aff6e");
    g.addColorStop(1, "#0a4020");
    ctx.fillStyle = g;
    ctx.fillRect(8, 0, pipeW, h);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(8 + pipeW * 0.22, 0, pipeW * 0.12, h);
    ctx.strokeStyle = "#00ff41";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(8, 0, pipeW, h);
    pipeSpriteRef.current = c;
    void w;
  }, [variant]);

  // Resize handler.
  //
  // The DISPLAY size of the wrap div is computed from the container so the
  // game visually fits the cabinet on every viewport. But the CANVAS BACKING
  // BUFFER is locked at config.width × config.height (480 × 853) — the same
  // coord space the simulator uses. We let CSS scale the buffer to the wrap
  // div's display size, which means:
  //   * physics renders at the same px coords on every device
  //   * the bird is always at the same proportional position
  //   * pipes spawn from the same x and arrive at the bird's x on the same
  //     tick on every device
  //   * what changes per-device is just the CSS scale factor
  const cfg = getVariantConfig(variant);
  useEffect(() => {
    function onResize() {
      const { w, h } = computeSize();
      sizeRef.current = { w, h };
      setSize({ w, h });
      const game = gameCanvasRef.current;
      if (game) {
        game.width = cfg.width;
        game.height = cfg.height;
        const gctx = game.getContext("2d");
        if (gctx) gctx.imageSmoothingEnabled = false;
      }
      renderBg(cfg.width, cfg.height);
      buildPipeSprite(cfg.width, cfg.height);
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [computeSize, renderBg, buildPipeSprite, cfg.width, cfg.height]);

  // Spawn flap particles
  const spawnFlap = useCallback((x: number, y: number) => {
    const pool = particlesRef.current;
    const cols = ["#00ff41", "#39ff14", "#ff2d78", "#ffffff"];
    let added = 0;
    for (let i = 0; i < pool.length && added < 12; i += 1) {
      const p = pool[i];
      if (p.alive) continue;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
      const sp = 2 + Math.random() * 4;
      p.alive = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.life = 1;
      p.dec = 0.04 + Math.random() * 0.04;
      p.r = 2 + Math.random() * 3;
      p.color = cols[(Math.random() * 4) | 0];
      added += 1;
    }
  }, []);

  const spawnDeath = useCallback((x: number, y: number) => {
    const pool = particlesRef.current;
    const cols = ["#ff2d78", "#ff69b4", "#ffffff", "#00ff41"];
    let added = 0;
    for (let i = 0; i < pool.length && added < 30; i += 1) {
      const p = pool[i];
      if (p.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      p.alive = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp - 3;
      p.life = 1;
      p.dec = 0.025 + Math.random() * 0.03;
      p.r = 2 + Math.random() * 5;
      p.color = cols[(Math.random() * 4) | 0];
      added += 1;
    }
  }, []);

  // Tap (flap) handler — used by keyboard + pointer + the start button
  const flap = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === "start") {
      // Start the game
      phaseRef.current = "playing";
      setPhase("playing");
      startTimeRef.current = performance.now();
      stateRef.current = createInitialState(variant, seed);
      prevStateRef.current = stateRef.current;
      tapsRef.current = [];
      pendingTapRef.current = true; // first tap counts
      accumulatorRef.current = 0;
      return;
    }
    if (ph !== "playing") return;
    pendingTapRef.current = true;
  }, [seed, variant]);

  const handleGameOver = useCallback(() => {
    const s = stateRef.current;
    phaseRef.current = "dead";
    setPhase("dead");
    setScore(s.score);
    if (s.score > best) {
      setBest(s.score);
      try {
        window.localStorage.setItem("pumpBirdBest", String(s.score));
      } catch {
        /* ignore */
      }
    }
    spawnDeath(s.bird.x + s.bird.width / 2, s.bird.y + s.bird.height / 2);
    onComplete({ score: s.score, ticks: s.tick, taps: tapsRef.current.slice() });
  }, [best, onComplete, spawnDeath]);

  // Auto-start when the sprite finishes loading (or use the procedural
  // fallback). Polls cheaply 5x/sec for ~3 seconds.
  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;
    const start = Date.now();
    const tryStart = () => {
      if (cancelled) return;
      if (phaseRef.current !== "start") return;
      if (spriteReadyRef.current) {
        flap();
        return;
      }
      if (Date.now() - start < 3000) {
        setTimeout(tryStart, 200);
      } else {
        // Sprite took too long — start anyway, fallback sprite will fill in
        flap();
      }
    };
    tryStart();
    return () => { cancelled = true; };
  }, [autoStart, flap]);

  // Fullscreen toggle for the game container
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Input bindings
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (phaseRef.current === "dead" && onRestart) {
          onRestart();
          return;
        }
        flap();
      } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === "Escape" && onExit) {
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flap, onExit, onRestart, toggleFullscreen]);

  // Main loop
  useEffect(() => {
    function loop(now: number) {
      rafRef.current = requestAnimationFrame(loop);
      const game = gameCanvasRef.current;
      if (!game) return;
      const ctx = game.getContext("2d");
      if (!ctx) return;
      // Wait for the display layout to settle so we don't draw into a 0-sized
      // wrap div. Canvas backing buffer is config-sized; CSS scales for display.
      if (sizeRef.current.w === 0) return;
      const config = getVariantConfig(variant);
      // Render in CONFIG coords (480 x 853). CSS scales the buffer to display.
      const w = config.width;
      const h = config.height;

      // Fixed timestep
      const last = lastFrameRef.current || now;
      const dt = Math.min(now - last, 100);
      lastFrameRef.current = now;

      if (phaseRef.current === "playing") {
        accumulatorRef.current += dt;
        while (accumulatorRef.current >= TICK_MS) {
          prevStateRef.current = stateRef.current;
          if (pendingTapRef.current) {
            tapsRef.current.push(stateRef.current.tick);
            stateRef.current = stepGame(stateRef.current, true);
            pendingTapRef.current = false;
            spawnFlap(
              stateRef.current.bird.x + stateRef.current.bird.width / 2,
              stateRef.current.bird.y + stateRef.current.bird.height / 2
            );
          } else {
            stateRef.current = stepGame(stateRef.current, false);
          }
          accumulatorRef.current -= TICK_MS;
          // Sync displayed score on tick boundary
          if (stateRef.current.score !== prevStateRef.current.score) {
            setScore(stateRef.current.score);
          }
          if (stateRef.current.gameover) {
            handleGameOver();
            break;
          }
        }
      }

      // Render
      ctx.clearRect(0, 0, w, h);
      const s = stateRef.current;
      const alpha = phaseRef.current === "playing"
        ? Math.min(accumulatorRef.current / TICK_MS, 1)
        : 0;
      const prev = prevStateRef.current;

      // Pipes
      const pipeSprite = pipeSpriteRef.current;
      if (pipeSprite) {
        for (const pipe of s.pipes) {
          // Interpolate x for buttery smooth motion
          const prevPipe = prev.pipes.find((p) => p.id === pipe.id);
          const x = prevPipe ? lerp(prevPipe.x, pipe.x, alpha) : pipe.x;
          // top half
          const topH = pipe.southY + config.pipeHeight;
          if (topH > 0) {
            ctx.drawImage(
              pipeSprite,
              0, 0, pipeSprite.width, Math.min(topH, h),
              x - 8, 0, pipeSprite.width, Math.min(topH, h)
            );
            // Cap lip
            ctx.fillStyle = "#39ff14";
            ctx.fillRect(x - 8, topH - 22, config.pipeWidth + 16, 22);
          }
          // bottom half
          const botY = pipe.northY;
          const botH = h - config.groundHeight - botY;
          if (botH > 0) {
            ctx.drawImage(
              pipeSprite,
              0, 0, pipeSprite.width, botH,
              x - 8, botY, pipeSprite.width, botH
            );
            ctx.fillStyle = "#39ff14";
            ctx.fillRect(x - 8, botY, config.pipeWidth + 16, 22);
          }
        }
      }

      // Bird — interpolated for smoothness. During start phase, replace y
      // and rotation with an idle bob so the bird gently floats while the
      // start screen overlay is up. Swap to the dead sprite when game over.
      const activeSprite =
        s.bird.dead && deadSpriteRef.current
          ? deadSpriteRef.current
          : idleSpriteRef.current;
      if (spriteReadyRef.current && activeSprite) {
        let bx = lerp(prev.bird.x, s.bird.x, alpha);
        let by = lerp(prev.bird.y, s.bird.y, alpha);
        let br = lerp(prev.bird.rotation, s.bird.rotation, alpha);
        if (phaseRef.current === "start") {
          const t = now * 0.002;
          bx = s.bird.x;
          by = s.bird.y + Math.sin(t) * 12;
          br = Math.sin(t) * 0.15;
        }
        ctx.save();
        ctx.translate(bx + s.bird.width / 2, by + s.bird.height / 2);
        ctx.rotate(Math.min(Math.max(br, -0.45), 1.2));
        ctx.drawImage(
          activeSprite as CanvasImageSource,
          -s.bird.width / 2,
          -s.bird.height / 2,
          s.bird.width,
          s.bird.height
        );
        ctx.restore();
      }

      // Particles
      const pool = particlesRef.current;
      let aliveCount = 0;
      for (let i = 0; i < pool.length; i += 1) {
        const p = pool[i];
        if (!p.alive) continue;
        aliveCount += 1;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.15;
        p.vx *= 0.98;
        p.life -= p.dec;
        if (p.life <= 0) {
          p.alive = false;
          continue;
        }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      void aliveCount;
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [handleGameOver, spawnFlap, variant]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Dead-state click → restart (if parent supports it) instead of flap.
      // Used by fun-mode + the embedded landing cabinet so a tap revives.
      if (phaseRef.current === "dead" && onRestart) {
        onRestart();
        return;
      }
      flap();
    },
    [flap, onRestart]
  );

  return (
    <div
      ref={containerRef}
      className="pb-game-wrap"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#030a03",
        overflow: "hidden",
        touchAction: "none"
      }}
    >
      <div
        style={{
          position: "relative",
          width: size.w || "auto",
          height: size.h || "auto"
        }}
      >
        <canvas
          ref={bgCanvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "block",
            imageRendering: "pixelated"
          }}
        />
        <canvas
          ref={gameCanvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "block",
            imageRendering: "pixelated",
            cursor: phase === "playing" ? "pointer" : "default",
            willChange: "transform",
            transform: "translateZ(0)",
            backfaceVisibility: "hidden",
            touchAction: "none"
          }}
          onPointerDown={onPointerDown}
        />

        {/* Fullscreen toggle — visible in every phase. Top-LEFT so it never
            collides with the landing-cabinet's ✕ close button (top-right) or
            with the score HUD. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            zIndex: 70,
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(7,18,7,0.85)",
            border: "2px solid #00ff41",
            color: "#00ff41",
            textShadow: "0 0 6px #00ff41",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 12,
            cursor: "pointer",
            padding: 0
          }}
        >
          {isFullscreen ? "⛶" : "⤢"}
        </button>

        {/* Game HUD — score + best */}
        {phase === "playing" && (
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 60,
              right: 16,
              display: "flex",
              justifyContent: "space-between",
              pointerEvents: "none",
              fontFamily: "'Press Start 2P', monospace",
              color: "#00ff41",
              textShadow: "0 0 8px #00ff41, 0 0 16px #00ff41"
            }}
          >
            <div>
              <div style={{ fontSize: 28, lineHeight: 1 }}>{String(score).padStart(3, "0")}</div>
              <div style={{ fontSize: 9, color: "#ff2d78", textShadow: "0 0 6px #ff2d78", marginTop: 6 }}>
                BEST {String(best).padStart(3, "0")}
              </div>
            </div>
            {mode === "fun" && (
              <div
                style={{
                  fontSize: 8,
                  border: "2px solid #ff2d78",
                  color: "#ff2d78",
                  textShadow: "0 0 6px #ff2d78",
                  padding: "4px 8px",
                  alignSelf: "flex-start"
                }}
              >
                PLAY FOR FUN
              </div>
            )}
          </div>
        )}

        {/* Start screen */}
        {phase === "start" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(3,10,3,0.9)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'Press Start 2P', monospace",
              padding: 20,
              textAlign: "center"
            }}
          >
            <div style={{ fontSize: 10, color: "#00ff41", textShadow: "0 0 8px #00ff41", marginBottom: 10 }}>
              💊 pump.fun
            </div>
            <div
              style={{
                fontSize: "clamp(20px, 6vw, 42px)",
                color: "#00ff41",
                textShadow: "0 0 10px #00ff41, 0 0 20px #00ff41",
                letterSpacing: 5,
                lineHeight: 1.4,
                marginBottom: 18
              }}
            >
              PUMP<br />BIRD
            </div>
            <div
              style={{
                fontSize: 10,
                color: "#ff2d78",
                textShadow: "0 0 8px #ff2d78",
                marginBottom: 20,
                animation: "pb-blink 1.2s step-end infinite"
              }}
            >
              {mode === "fun" ? "PLAY FOR FUN — NO ENTRY" : "ENTRY PAID — BEAT THE HIGH SCORE"}
            </div>
            <button
              type="button"
              onClick={flap}
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 12,
                background: "rgba(0,255,65,0.1)",
                border: "3px solid #00ff41",
                color: "#00ff41",
                textShadow: "0 0 8px #00ff41",
                padding: "14px 28px",
                letterSpacing: 2,
                cursor: "pointer"
              }}
            >
              ▶ START GAME
            </button>
            <div
              style={{
                fontSize: 8,
                color: "rgba(0,255,65,0.6)",
                letterSpacing: 1,
                marginTop: 20
              }}
            >
              SPACE / CLICK / TAP TO FLAP
            </div>
          </div>
        )}

        {/* Game-over screen.
            pointer-events: none on the overlay so a tap anywhere on the canvas
            beneath fires onPointerDown → onRestart (when provided). The
            buttons re-enable pointer-events to stay clickable. */}
        {phase === "dead" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(3,10,3,0.92)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'Press Start 2P', monospace",
              padding: 20,
              textAlign: "center",
              pointerEvents: onRestart ? "none" : "auto"
            }}
          >
            <div
              style={{
                fontSize: "clamp(30px, 9vw, 76px)",
                color: "#ff2d78",
                textShadow: "0 0 10px #ff2d78, 0 0 30px #ff2d78",
                letterSpacing: 6,
                marginBottom: 14
              }}
            >
              REKT
            </div>
            <div style={{ fontSize: 14, color: "#00ff41", textShadow: "0 0 8px #00ff41", marginBottom: 6 }}>
              SCORE: {String(score).padStart(3, "0")}
            </div>
            <div style={{ fontSize: 11, color: "#ff2d78", textShadow: "0 0 6px #ff2d78", marginBottom: 18 }}>
              BEST: {String(best).padStart(3, "0")}
            </div>
            <div
              style={{
                fontSize: 10,
                padding: "5px 12px",
                border: "2px solid #ff2d78",
                color: "#ff2d78",
                textShadow: "0 0 6px #ff2d78",
                marginBottom: 18,
                letterSpacing: 1
              }}
            >
              {mode === "fun" ? "NGMI — TRY AGAIN" : "SCORE SUBMITTED"}
            </div>
            {onRestart && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRestart(); }}
                style={{
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: 12,
                  background: "rgba(0,255,65,0.12)",
                  border: "3px solid #00ff41",
                  color: "#00ff41",
                  textShadow: "0 0 8px #00ff41",
                  padding: "14px 28px",
                  letterSpacing: 2,
                  cursor: "pointer",
                  marginBottom: 8,
                  pointerEvents: "auto"
                }}
              >
                ↺ TAP TO PLAY AGAIN
              </button>
            )}
            {onRestart && (
              <div style={{
                fontSize: 8,
                color: "rgba(0,255,65,0.7)",
                letterSpacing: 1,
                marginTop: 4,
                marginBottom: 12,
                animation: "pb-blink 1.2s step-end infinite"
              }}>
                ▸ TAP ANYWHERE / SPACE TO RETRY ◂
              </div>
            )}
            {onExit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onExit(); }}
                style={{
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: 11,
                  background: "rgba(0,255,65,0.1)",
                  border: "3px solid #00ff41",
                  color: "#00ff41",
                  textShadow: "0 0 8px #00ff41",
                  padding: "12px 24px",
                  letterSpacing: 2,
                  cursor: "pointer",
                  pointerEvents: "auto"
                }}
              >
                ◂ EXIT
              </button>
            )}
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes pb-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}
