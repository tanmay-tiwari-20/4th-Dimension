"use client";

import { ChangeEvent, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Grid, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";

const FRAME_COUNT = 48;
const MAX_FRAME_EDGE = 384;
const CUBE_WIDTH = 2.8;
const CUBE_HEIGHT = 2.35;
const CUBE_DEPTH = 3.2;

type TemporalFrameData = { time: number; canvas: HTMLCanvasElement };
type VideoMetadata = { duration: number; width: number; height: number };

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function waitForMetadata(video: HTMLVideoElement, isCurrent: () => boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("This video could not be decoded by your browser. Try an MP4 encoded with H.264 or a WebM video.")); };
    const cancelled = () => { cleanup(); reject(new Error("Frame extraction was cancelled.")); };
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) return cancelled();
    if (!isCurrent()) { cleanup(); reject(new Error("Frame extraction was cancelled.")); }
  });
}

function seekAndCapture(video: HTMLVideoElement, canvas: HTMLCanvasElement, time: number, isCurrent: () => boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (!isCurrent()) return reject(new Error("Frame extraction was cancelled."));
    const capture = () => {
      if (!isCurrent()) return reject(new Error("Frame extraction was cancelled."));
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return reject(new Error("The video has no readable frames."));
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return reject(new Error("Your browser could not prepare a canvas for frame extraction."));
      try { context.drawImage(video, 0, 0, canvas.width, canvas.height); resolve(); }
      catch { reject(new Error("A video frame could not be read. Try another supported video file.")); }
    };
    if (Math.abs(video.currentTime - time) < 0.0005 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      capture();
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Video seeking timed out. Try a shorter or more widely supported video."));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onSeeked = () => { cleanup(); capture(); };
    const onError = () => { cleanup(); reject(new Error("The browser encountered a decoding error while reading this video.")); };
    const onAbort = () => { cleanup(); reject(new Error("Frame extraction was cancelled.")); };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    video.currentTime = time;
  });
}

async function extractVideoFrames(url: string, isCurrent: () => boolean, onProgress: (done: number) => void, signal: AbortSignal) {
  const extractor = document.createElement("video");
  extractor.preload = "auto";
  extractor.muted = true;
  extractor.playsInline = true;
  extractor.src = url;
  extractor.load();
  try {
    await waitForMetadata(extractor, isCurrent, signal);
    if (!isCurrent()) throw new Error("Frame extraction was cancelled.");
    const duration = extractor.duration;
    const width = extractor.videoWidth;
    const height = extractor.videoHeight;
    if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
      throw new Error("This video has no usable duration or dimensions.");
    }
    const metadata = { duration, width, height } satisfies VideoMetadata;
    const count = Math.min(FRAME_COUNT, Math.max(2, Math.ceil(duration * 2)));
    const frames: TemporalFrameData[] = [];
    for (let index = 0; index < count; index += 1) {
      if (!isCurrent()) throw new Error("Frame extraction was cancelled.");
      const time = count === 1 ? 0 : (duration * index) / (count - 1);
      const canvas = document.createElement("canvas");
      await seekAndCapture(extractor, canvas, Math.min(time, Math.max(0, duration - 0.001)), isCurrent, signal);
      frames.push({ time, canvas });
      onProgress(index + 1);
    }
    return { frames, metadata };
  } finally {
    extractor.pause();
    extractor.removeAttribute("src");
    extractor.load();
  }
}

function TemporalFrames({ frames, depthScale, timeProgress, duration, onSeek }: {
  frames: TemporalFrameData[];
  depthScale: number;
  timeProgress: React.MutableRefObject<number>;
  duration: number;
  onSeek: (time: number) => void;
}) {
  const playhead = useRef<THREE.Group>(null);
  const frameTextures = useMemo(() => frames.map(({ canvas }) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }), [frames]);

  useEffect(() => () => frameTextures.forEach(texture => texture.dispose()), [frameTextures]);

  useFrame(() => {
    if (playhead.current) playhead.current.position.z = (timeProgress.current - 0.5) * CUBE_DEPTH * depthScale;
  });

  const dimensions = useMemo(() => frames.map(({ canvas }) => {
    const ratio = canvas.width / canvas.height;
    const width = Math.min(0.31, 0.27 * ratio);
    return [width, width / ratio] as const;
  }), [frames]);
  const borderGeometries = useMemo(() => dimensions.map(([width, height]) => {
    const source = new THREE.PlaneGeometry(width + 0.018, height + 0.018);
    const edges = new THREE.EdgesGeometry(source);
    source.dispose();
    return edges;
  }), [dimensions]);
  const playheadEdges = useMemo(() => {
    const source = new THREE.PlaneGeometry(CUBE_WIDTH, CUBE_HEIGHT);
    const edges = new THREE.EdgesGeometry(source);
    source.dispose();
    return edges;
  }, []);
  useEffect(() => () => borderGeometries.forEach(geometry => geometry.dispose()), [borderGeometries]);
  useEffect(() => () => playheadEdges.dispose(), [playheadEdges]);

  return (
    <group>
      {frames.map((frame, index) => {
        // Arrange thumbnails across the cube's cross-section while keeping time strictly on Z.
        const column = index % 8;
        const row = Math.floor(index / 8);
        const x = (column - 3.5) * 0.34;
        const y = (row - 2.5) * 0.36;
        const z = ((frame.time / Math.max(duration, 0.001)) - 0.5) * CUBE_DEPTH * depthScale;
        const [width, height] = dimensions[index];
        return (
          <group key={`${frame.time}-${index}`} position={[x, y, z]} onClick={event => { event.stopPropagation(); onSeek(frame.time); }}>
            <mesh>
              <planeGeometry args={[width, height]} />
              <meshBasicMaterial map={frameTextures[index]} side={THREE.DoubleSide} toneMapped={false} />
            </mesh>
            <lineSegments position={[0, 0, 0.002]}>
              <primitive object={borderGeometries[index]} attach="geometry" />
              <lineBasicMaterial color="#80dcff" transparent opacity={0.52} />
            </lineSegments>
          </group>
        );
      })}
      <group ref={playhead}>
        <mesh>
          <planeGeometry args={[CUBE_WIDTH, CUBE_HEIGHT]} />
          <meshBasicMaterial color="#55d9ff" transparent opacity={0.075} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <lineSegments>
          <primitive object={playheadEdges} attach="geometry" />
          <lineBasicMaterial color="#66dcff" transparent opacity={0.9} />
        </lineSegments>
      </group>
    </group>
  );
}

const StableTemporalFrames = memo(TemporalFrames, (previous, next) =>
  previous.frames === next.frames && previous.depthScale === next.depthScale &&
  previous.timeProgress === next.timeProgress && previous.duration === next.duration && previous.onSeek === next.onSeek
);

function Scene({ frames, currentTime, duration, depthScale, onSeek, resetKey, controlsRef }: {
  frames: TemporalFrameData[];
  currentTime: number;
  duration: number;
  depthScale: number;
  onSeek: (time: number) => void;
  resetKey: number;
  controlsRef: React.RefObject<OrbitControlsImpl>;
}) {
  const timeProgress = useRef(0);
  const boundsGeometry = useMemo(() => {
    const box = new THREE.BoxGeometry(CUBE_WIDTH, CUBE_HEIGHT, CUBE_DEPTH);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, []);
  useEffect(() => () => boundsGeometry.dispose(), [boundsGeometry]);
  useEffect(() => {
    timeProgress.current = duration > 0 ? THREE.MathUtils.clamp(currentTime / duration, 0, 1) : 0;
  }, [currentTime, duration]);
  useEffect(() => {
    if (resetKey) controlsRef.current?.reset();
  }, [resetKey, controlsRef]);

  return (
    <>
      <color attach="background" args={["#070a10"]} />
      <ambientLight intensity={1.5} />
      <pointLight position={[4, 4, 5]} intensity={18} color="#77dfff" />
      <pointLight position={[-4, -2, -3]} intensity={10} color="#7865ff" />
      <Suspense fallback={null}>
        {frames.length > 0 && <StableTemporalFrames frames={frames} depthScale={depthScale} timeProgress={timeProgress} duration={duration} onSeek={onSeek} />}
        <Environment preset="city" />
      </Suspense>
      <lineSegments scale={[1, 1, depthScale]}>
        <primitive object={boundsGeometry} attach="geometry" />
        <lineBasicMaterial color="#77dfff" transparent opacity={0.78} />
      </lineSegments>
      <Grid position={[0, -1.5, 0]} args={[12, 12]} cellSize={0.5} cellThickness={0.35} cellColor="#1a2a3a" sectionSize={2} sectionThickness={0.7} sectionColor="#27445a" fadeDistance={9} infiniteGrid />
      <OrbitControls ref={controlsRef} enablePan={false} minDistance={2.8} maxDistance={8} enableDamping dampingFactor={0.08} />
    </>
  );
}

export default function TemporalStudio() {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlRef = useRef("");
  const extractionId = useRef(0);
  const extractionAbort = useRef<AbortController | null>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [frames, setFrames] = useState<TemporalFrameData[]>([]);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [videoDimensions, setVideoDimensions] = useState<VideoMetadata | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [depthScale, setDepthScale] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resetKey, setResetKey] = useState(0);

  const disposeVideo = useCallback(() => {
    const old = videoRef.current;
    if (old) {
      old.pause();
      old.removeAttribute("src");
      old.load();
      videoRef.current = null;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
  }, []);

  const loadFile = useCallback(async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setError("Choose a video file such as MP4, WebM, or MOV.");
      return;
    }
    extractionAbort.current?.abort();
    const controller = new AbortController();
    extractionAbort.current = controller;
    const jobId = ++extractionId.current;
    disposeVideo();
    setVideo(null);
    setFrames([]);
    setFileName(file.name);
    setDuration(0);
    setVideoDimensions(null);
    setCurrentTime(0);
    setPlaying(false);
    setError("");
    setLoading(true);
    setProgress(0);

    const url = URL.createObjectURL(file);
    urlRef.current = url;
    const player = document.createElement("video");
    player.src = url;
    player.muted = false;
    player.volume = volume;
    player.loop = false;
    player.playsInline = true;
    player.preload = "auto";
    player.onloadedmetadata = () => {
      if (jobId !== extractionId.current) return;
      setDuration(player.duration || 0);
      setCurrentTime(0);
      videoRef.current = player;
      setVideo(player);
    };
    player.onerror = () => {
      if (jobId === extractionId.current) setError("This video could not be decoded by your browser. Try an MP4 encoded with H.264 or a WebM video.");
    };
    player.load();

    try {
      const result = await extractVideoFrames(url, () => jobId === extractionId.current, done => setProgress(done), controller.signal);
      if (jobId !== extractionId.current) return;
      setFrames(result.frames);
      setDuration(result.metadata.duration);
      setVideoDimensions(result.metadata);
      setError("");
    } catch (cause) {
      if (jobId === extractionId.current) {
        setFrames([]);
        setError(cause instanceof Error ? cause.message : "Frames could not be extracted from this video.");
      }
    } finally {
      if (jobId === extractionId.current) setLoading(false);
    }
  }, [disposeVideo, volume]);

  useEffect(() => {
    if (!video) return;
    const update = () => setCurrentTime(video.currentTime || 0);
    const ended = () => setPlaying(false);
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    video.addEventListener("timeupdate", update);
    video.addEventListener("ended", ended);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    return () => {
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("ended", ended);
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
    };
  }, [video]);

  useEffect(() => { if (video) video.playbackRate = speed; }, [video, speed]);
  useEffect(() => { if (video) video.volume = volume; }, [video, volume]);
  useEffect(() => () => { extractionId.current += 1; extractionAbort.current?.abort(); disposeVideo(); }, [disposeVideo]);

  const togglePlay = async () => {
    if (!video) { inputRef.current?.click(); return; }
    if (video.paused) {
      try { await video.play(); setPlaying(true); }
      catch { setError("Playback was blocked. Try pressing play again."); }
    } else video.pause();
  };

  const seek = useCallback((value: number) => {
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = Math.max(0, Math.min(duration, value));
    setCurrentTime(video.currentTime);
  }, [video, duration]);
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void loadFile(event.target.files?.[0]);
    event.target.value = "";
  };

  return (
    <main className="app-shell" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void loadFile(event.dataTransfer.files?.[0]); }}>
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">◈</span> <span className="brand-name">4th Dimension</span></a>
        <div className="top-status"><span className="status-dot" /> EXPLORE TIME <span className="version">BETA 0.2</span></div>
        <button className="text-button" onClick={() => inputRef.current?.click()}>＋ Upload video</button>
      </header>

      <section className="hero">
        <div className="eyebrow"><span /> AN EXPERIMENT IN TIME</div>
        <h1>Time is more than a moment.<br /><em>Explore it in another dimension.</em></h1>
        <p className="hero-copy">Turn ordinary video into a space you can explore.<br className="desktop-break" /> Rotate the moment. Move through time.</p>
      </section>

      <section className="workspace">
        <div className="scene-panel">
          <div className="scene-topline">
            <div><span className="micro-label">TEMPORAL CUBE</span><span className="scene-name">{fileName || "Untitled temporal object"}</span></div>
            <div className="view-pill"><span className="status-dot" /> {loading ? `EXTRACTING ${progress}/${FRAME_COUNT}` : frames.length ? `${frames.length} FRAMES` : "3D SPACE"}</div>
          </div>
          <div className="canvas-wrap">
            <Canvas camera={{ position: [3.6, 2.5, 4.5], fov: 43 }} dpr={[1, 1.5]}>
              <Scene frames={frames} currentTime={currentTime} duration={duration} depthScale={depthScale} onSeek={seek} resetKey={resetKey} controlsRef={controlsRef} />
            </Canvas>
            {frames.length === 0 && !loading && (
              <div className="empty-overlay">
                <div className="upload-symbol">↥</div>
                <p className="empty-title">Give time a new dimension</p>
                <p className="empty-copy">Upload a video to map its moments through a temporal cube.</p>
                <button className="primary-button" onClick={() => inputRef.current?.click()}>Select a video <span>↗</span></button>
                <span className="file-hint">MP4 · WEBM · MOV</span>
              </div>
            )}
            {loading && <div className="loading-overlay"><div className="loading-ring" /><strong>Extracting video moments</strong><span>{progress} of {FRAME_COUNT} frames · processing locally</span><div className="progress-track"><i style={{ width: `${(progress / FRAME_COUNT) * 100}%` }} /></div></div>}
            <div className="canvas-hint"><span>↻</span> DRAG TO ROTATE <span className="hint-divider">/</span> SCROLL TO ZOOM</div>
            <div className="axis-label axis-x">X <span>WIDTH</span></div>
            <div className="axis-label axis-y">Y <span>HEIGHT</span></div>
            <div className="axis-label axis-z">Z <span>TIME</span></div>
          </div>
          <div className="scene-footer">
            <span><span className="legend-line" /> TEMPORAL CUBE</span>
            <span>{videoDimensions ? `${videoDimensions.width} × ${videoDimensions.height} · ${frames.length} MOMENTS` : "BEGINNING → END"}</span>
            <button className="reset-button" onClick={() => setResetKey(value => value + 1)}>↺ Reset view</button>
          </div>
        </div>

        <aside className="control-panel">
          <div className="panel-heading"><span className="micro-label">TIME NAVIGATION</span><span className="panel-index">01 / 03</span></div>
          <div className="control-section">
            <div className="section-title">Source material <span className="step-number">01</span></div>
            <button className="upload-card" onClick={() => inputRef.current?.click()}>
              <span className="upload-card-icon">↥</span>
              <span className="upload-card-text"><strong>{fileName || "Choose a video"}</strong><small>{fileName ? "Click to replace source" : "Drop a file into this space"}</small></span>
              <span className="upload-arrow">↗</span>
            </button>
            {error && <p className="error-message">{error}</p>}
          </div>

          <div className="control-section">
            <div className="section-title">Navigate time <span className="step-number">02</span></div>
            <div className="time-readout"><strong>{formatTime(currentTime)}</strong><span>/ {formatTime(duration)}</span></div>
            <input aria-label="Video timeline" className="range-input" type="range" min={0} max={duration || 1} step={0.01} value={Math.min(currentTime, duration || 1)} onChange={e => seek(Number(e.target.value))} style={{ "--range-progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties} />
            <div className="range-labels"><span>BEGINNING</span><span>END</span></div>
            <div className="transport">
              <button title="Back one second" onClick={() => seek(Math.max(0, currentTime - 1))}>↶<small>1s</small></button>
              <button className="play-button" onClick={togglePlay}>{playing ? "Ⅱ" : "▶"}</button>
              <button title="Forward one second" onClick={() => seek(Math.min(duration, currentTime + 1))}>↷<small>1s</small></button>
            </div>
            <div className="speed-row"><label htmlFor="speed">Playback speed</label><select id="speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></div>
          </div>

          <div className="control-section">
            <div className="section-title">Temporal depth <span className="step-number">03</span></div>
            <div className="depth-readout"><span>FRAME SPACING</span><strong>{depthScale.toFixed(2)}×</strong></div>
            <input aria-label="Temporal depth" className="range-input depth-range" type="range" min={0.65} max={1.8} step={0.01} value={depthScale} onChange={event => setDepthScale(Number(event.target.value))} style={{ "--range-progress": `${((depthScale - 0.65) / 1.15) * 100}%` } as React.CSSProperties} />
            <div className="range-labels"><span>COMPRESS</span><span>EXPAND</span></div>
            <div className="property-row"><div><strong>Frame mapping</strong><small>Local video moments</small></div><span className="property-value">{loading ? "BUILDING" : frames.length ? "ACTIVE" : "STANDBY"}</span></div>
            <div className="property-row"><div><strong>Playback rate</strong><small>Timeline velocity</small></div><span className="property-value">{speed.toFixed(2)}×</span></div>
          </div>
          <div className="privacy-note"><span>◈</span><p><strong>Your footage stays local.</strong><br />Video frames are processed in your browser. Files are never uploaded.</p></div>
        </aside>
      </section>

      <footer className="footer"><span>4TH DIMENSION © 2026</span><span>THREE DIMENSIONS. ONE TIMELINE. INFINITE PERSPECTIVES.</span><span>BUILT TO EXPLORE</span></footer>
      <input ref={inputRef} type="file" accept="video/*" hidden onChange={onFileChange} />
    </main>
  );
}
