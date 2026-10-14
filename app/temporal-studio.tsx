"use client";

import { ChangeEvent, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";

const FRAME_COUNT = 120;
const MAX_FRAME_EDGE = 384;
const CUBE_WIDTH = 2.8;
const CUBE_HEIGHT = 2.35;
const CUBE_DEPTH = 3.2;

type TemporalFrameData = { time: number; canvas: HTMLCanvasElement };
type VideoMetadata = { duration: number; width: number; height: number };
type InteractionMode = "timeline" | "slice" | "inspect";

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function FrameThumbnail({ frame }: { frame: TemporalFrameData | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvasRef.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    if (frame) context.drawImage(frame.canvas, 0, 0, target.width, target.height);
  }, [frame]);
  return <canvas ref={canvasRef} className="inspection-thumbnail" width={128} height={72} aria-label={frame ? `Frame at ${formatTime(frame.time)}` : "No frame selected"} />;
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
    const count = Math.min(FRAME_COUNT, Math.max(2, Math.ceil(duration * 4)));
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

function createCoverGeometry(width: number, height: number, videoAspect: number) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const planeAspect = width / height;
  const uScale = videoAspect > planeAspect ? planeAspect / videoAspect : 1;
  const vScale = videoAspect < planeAspect ? videoAspect / planeAspect : 1;
  const uOffset = (1 - uScale) / 2;
  const vOffset = (1 - vScale) / 2;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(index, uOffset + uv.getX(index) * uScale, vOffset + uv.getY(index) * vScale);
  }
  uv.needsUpdate = true;
  return geometry;
}

function VideoProjection({ video, frames, opacity, depthScale, duration, onSeek, controlsRef }: {
  video: HTMLVideoElement | null;
  frames: TemporalFrameData[];
  opacity: number;
  depthScale: number;
  duration: number;
  onSeek: (time: number) => void;
  controlsRef: React.RefObject<OrbitControlsImpl>;
}) {
  const texture = useMemo(() => {
    if (!video) return null;
    const result = new THREE.VideoTexture(video);
    result.colorSpace = THREE.SRGBColorSpace;
    result.minFilter = THREE.LinearFilter;
    result.magFilter = THREE.LinearFilter;
    result.generateMipmaps = false;
    return result;
  }, [video]);
  const material = useMemo(() => texture ? new THREE.MeshBasicMaterial({
    map: texture, side: THREE.DoubleSide, transparent: true, opacity,
    depthWrite: false, toneMapped: false,
  }) : null, [texture]);
  const frameTextures = useMemo(() => frames.map(({ canvas }) => {
    const frameTexture = new THREE.CanvasTexture(canvas);
    frameTexture.colorSpace = THREE.SRGBColorSpace;
    frameTexture.minFilter = THREE.LinearFilter;
    frameTexture.magFilter = THREE.LinearFilter;
    frameTexture.generateMipmaps = false;
    return frameTexture;
  }), [frames]);
  const frameMaterials = useMemo(() => frameTextures.map(frameTexture => new THREE.MeshBasicMaterial({
    map: frameTexture, side: THREE.DoubleSide, transparent: true,
    opacity: 0,
    depthWrite: false, toneMapped: false,
  })), [frameTextures]);
  const wasPlaying = useRef(false);
  const dragging = useRef(false);
  const projection = useRef<THREE.Group>(null);
  const videoAspect = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const sliceGeometry = useMemo(() => createCoverGeometry(CUBE_WIDTH, CUBE_HEIGHT, videoAspect), [videoAspect]);
  const screenEdges = useMemo(() => {
    const source = new THREE.PlaneGeometry(CUBE_WIDTH + 0.018, CUBE_HEIGHT + 0.018);
    const edges = new THREE.EdgesGeometry(source);
    source.dispose();
    return edges;
  }, []);
  const wallGeometry = useMemo(() => {
    const geometries = [
      createCoverGeometry(CUBE_WIDTH, CUBE_HEIGHT, videoAspect),
      createCoverGeometry(CUBE_WIDTH, CUBE_HEIGHT, videoAspect),
      createCoverGeometry(CUBE_WIDTH, CUBE_DEPTH, videoAspect),
      createCoverGeometry(CUBE_WIDTH, CUBE_DEPTH, videoAspect),
      createCoverGeometry(CUBE_DEPTH, CUBE_HEIGHT, videoAspect),
      createCoverGeometry(CUBE_DEPTH, CUBE_HEIGHT, videoAspect),
    ];
    return geometries;
  }, [videoAspect]);
  const wallTransforms = [
    { position: [0, 0, -CUBE_DEPTH / 2 + 0.006] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { position: [0, 0, CUBE_DEPTH / 2 - 0.006] as [number, number, number], rotation: [0, Math.PI, 0] as [number, number, number] },
    { position: [0, CUBE_HEIGHT / 2 - 0.006, 0] as [number, number, number], rotation: [-Math.PI / 2, 0, 0] as [number, number, number] },
    { position: [0, -CUBE_HEIGHT / 2 + 0.006, 0] as [number, number, number], rotation: [Math.PI / 2, 0, 0] as [number, number, number] },
    { position: [-CUBE_WIDTH / 2 + 0.006, 0, 0] as [number, number, number], rotation: [0, -Math.PI / 2, 0] as [number, number, number] },
    { position: [CUBE_WIDTH / 2 - 0.006, 0, 0] as [number, number, number], rotation: [0, Math.PI / 2, 0] as [number, number, number] },
  ];

  useEffect(() => {
    if (material) material.opacity = opacity;
  }, [material, opacity]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useEffect(() => () => material?.dispose(), [material]);
  useEffect(() => () => frameTextures.forEach(frameTexture => frameTexture.dispose()), [frameTextures]);
  useEffect(() => () => frameMaterials.forEach(frameMaterial => frameMaterial.dispose()), [frameMaterials]);
  useEffect(() => () => sliceGeometry.dispose(), [sliceGeometry]);
  useEffect(() => () => wallGeometry.forEach(geometry => geometry.dispose()), [wallGeometry]);
  useEffect(() => () => screenEdges.dispose(), [screenEdges]);

  useEffect(() => {
    frameMaterials.forEach(frameMaterial => { frameMaterial.opacity = opacity / Math.max(1, Math.sqrt(frameMaterials.length)); });
    if (material) material.opacity = opacity;
  }, [frameMaterials, material, opacity]);

  useFrame(() => {
    if (projection.current && video && duration > 0) {
      const progress = THREE.MathUtils.clamp(video.currentTime / duration, 0, 1);
      projection.current.position.z = (progress - 0.5) * CUBE_DEPTH;
    }
  });

  const seekFromDepth = (z: number) => {
    if (duration <= 0) return;
    const depth = CUBE_DEPTH * depthScale;
    const progress = THREE.MathUtils.clamp((z / (depth * 0.94)) + 0.5, 0, 1);
    onSeek(progress * duration);
  };
  const beginDepthDrag = (event: ThreeEvent<PointerEvent>) => {
    if (event.nativeEvent.button !== 0) return;
    event.stopPropagation();
    dragging.current = true;
    wasPlaying.current = Boolean(video && !video.paused);
    video?.pause();
    if (controlsRef.current) controlsRef.current.enabled = false;
    (event.target as unknown as { setPointerCapture: (pointerId: number) => void }).setPointerCapture(event.pointerId);
    seekFromDepth(event.point.z);
  };
  const moveDepthDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    event.stopPropagation();
    seekFromDepth(event.point.z);
  };
  const endDepthDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    event.stopPropagation();
    dragging.current = false;
    if (controlsRef.current) controlsRef.current.enabled = true;
    (event.target as unknown as { releasePointerCapture: (pointerId: number) => void }).releasePointerCapture(event.pointerId);
    if (wasPlaying.current) void video?.play().catch(() => undefined);
  };

  return (
    <group scale={[1, 1, depthScale]}>
      {video && material && (
        <>
          {wallTransforms.map((wall, index) => (
            <mesh key={`wall-${index}`} position={wall.position} rotation={wall.rotation} geometry={wallGeometry[index]} material={material} renderOrder={1} />
          ))}
          {frameMaterials.map((frameMaterial, index) => {
            const progress = frameMaterials.length > 1 ? index / (frameMaterials.length - 1) : 0.5;
            const position = (progress - 0.5) * CUBE_DEPTH * 0.92;
            return <mesh key={`slice-${index}`} position={[0, 0, position]} geometry={sliceGeometry} material={frameMaterial} renderOrder={2} />;
          })}
          <group ref={projection}>
          <mesh geometry={sliceGeometry} material={material} renderOrder={3} />
          <lineSegments position={[0, 0, 0.006]}>
            <primitive object={screenEdges} attach="geometry" />
            <lineBasicMaterial color="#b6e6ed" transparent opacity={0.48} />
          </lineSegments>
          </group>
          <mesh position={[CUBE_WIDTH / 2 - 0.045, 0, 0]} rotation={[0, Math.PI / 2, 0]}
            onPointerDown={beginDepthDrag} onPointerMove={moveDepthDrag} onPointerUp={endDepthDrag} onPointerCancel={endDepthDrag}>
            <planeGeometry args={[CUBE_DEPTH * 0.94, CUBE_HEIGHT * 0.35]} />
            <meshBasicMaterial color="#8bdae8" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <mesh position={[CUBE_WIDTH / 2 - 0.035, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[CUBE_DEPTH * 0.94, 0.014]} />
            <meshBasicMaterial color="#b3edf5" transparent opacity={0.68} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}

function Scene({ video, frames, duration, depthScale, frameOpacity, autoRotate, playing, playbackVideo, onSeek, resetKey, controlsRef }: {
  video: HTMLVideoElement | null;
  frames: TemporalFrameData[];
  duration: number;
  depthScale: number;
  frameOpacity: number;
  autoRotate: boolean;
  playing: boolean;
  playbackVideo: React.RefObject<HTMLVideoElement | null>;
  onSeek: (time: number) => void;
  resetKey: number;
  controlsRef: React.RefObject<OrbitControlsImpl>;
}) {
  const timeProgress = useRef(0);
  const playhead = useRef<THREE.Group>(null);
  const sliceLabel = useRef<HTMLSpanElement>(null);
  const manualInteraction = useRef(false);
  const boundsGeometry = useMemo(() => {
    const box = new THREE.BoxGeometry(CUBE_WIDTH, CUBE_HEIGHT, CUBE_DEPTH);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, []);
  const playheadEdges = useMemo(() => {
    const source = new THREE.PlaneGeometry(CUBE_WIDTH, CUBE_HEIGHT);
    const edges = new THREE.EdgesGeometry(source);
    source.dispose();
    return edges;
  }, []);
  const starGeometry = useMemo(() => {
    const positions = new Float32Array(180 * 3);
    for (let index = 0; index < 180; index += 1) {
      const values = [index * 127.1, index * 311.7, index * 74.7].map(value => {
        const sine = Math.sin(value) * 43758.5453;
        return (sine - Math.floor(sine)) * 2 - 1;
      });
      const length = Math.hypot(values[0], values[1], values[2]) || 1;
      const radius = 6.2 + ((index * 17) % 29) / 10;
      positions[index * 3] = (values[0] / length) * radius;
      positions[index * 3 + 1] = (values[1] / length) * radius;
      positions[index * 3 + 2] = (values[2] / length) * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);
  useEffect(() => () => { boundsGeometry.dispose(); playheadEdges.dispose(); starGeometry.dispose(); }, [boundsGeometry, playheadEdges, starGeometry]);
  useFrame(() => {
    const source = playbackVideo.current;
    if (source && duration > 0) timeProgress.current = THREE.MathUtils.clamp(source.currentTime / duration, 0, 1);
    if (playhead.current) playhead.current.position.z = (timeProgress.current - 0.5) * CUBE_DEPTH * depthScale;
    if (sliceLabel.current) sliceLabel.current.textContent = formatTime(timeProgress.current * duration);
    const controls = controlsRef.current;
    if (controls) controls.autoRotate = autoRotate && !playing && !manualInteraction.current;
  });
  useEffect(() => {
    if (resetKey) controlsRef.current?.reset();
  }, [resetKey, controlsRef]);

  return (
    <>
      <color attach="background" args={["#070a10"]} />
      <points geometry={starGeometry}>
        <pointsMaterial color="#c6d2dc" size={0.018} transparent opacity={0.56} sizeAttenuation depthWrite={false} />
      </points>
      <ambientLight intensity={0.65} />
      <pointLight position={[3.5, 3, 4]} intensity={12} color="#b4d8e8" />
      <pointLight position={[-3, -2, -3]} intensity={6} color="#47708a" />
      <Suspense fallback={null}>
        <VideoProjection video={video} frames={frames} opacity={frameOpacity} depthScale={depthScale} duration={duration} onSeek={onSeek} controlsRef={controlsRef} />
      </Suspense>
      <mesh scale={[1, 1, depthScale]}>
        <boxGeometry args={[CUBE_WIDTH, CUBE_HEIGHT, CUBE_DEPTH]} />
        <meshPhysicalMaterial color="#b7c5cb" transparent opacity={0.045} roughness={0.24} metalness={0.16} clearcoat={0.7} clearcoatRoughness={0.24} side={THREE.DoubleSide} depthWrite={false} envMapIntensity={0.55} />
      </mesh>
      <lineSegments scale={[1, 1, depthScale]}>
        <primitive object={boundsGeometry} attach="geometry" />
        <lineBasicMaterial color="#b9c8cf" transparent opacity={0.58} />
      </lineSegments>
      <group ref={playhead}>
        <mesh>
          <planeGeometry args={[CUBE_WIDTH, CUBE_HEIGHT]} />
          <meshBasicMaterial color="#c2ac84" transparent opacity={0.045} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <lineSegments>
          <primitive object={playheadEdges} attach="geometry" />
          <lineBasicMaterial color="#c9b58f" transparent opacity={0.82} />
        </lineSegments>
        <Html position={[CUBE_WIDTH / 2 + 0.04, CUBE_HEIGHT / 2 + 0.08, 0]} center distanceFactor={7} style={{ pointerEvents: "none" }}>
          <span ref={sliceLabel} className="slice-scene-label">00:00.00</span>
        </Html>
      </group>
      {!video && (
        <group scale={[1, 1, depthScale]}>
          {Array.from({ length: 13 }, (_, index) => {
            const progress = index / 12;
            const position = (progress - 0.5) * CUBE_DEPTH * 0.9;
            const central = index === 6;
            return (
              <group key={`idle-slice-${index}`} position={[0, 0, position]}>
                <mesh>
                  <planeGeometry args={[CUBE_WIDTH * 0.94, CUBE_HEIGHT * 0.9]} />
                  <meshBasicMaterial color={central ? "#c2ac84" : "#8ea5b0"} transparent opacity={central ? 0.035 : 0.012} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>
                <lineSegments>
                  <primitive object={playheadEdges} attach="geometry" />
                  <lineBasicMaterial color={central ? "#c2ac84" : "#93a7af"} transparent opacity={central ? 0.42 : 0.13} />
                </lineSegments>
              </group>
            );
          })}
        </group>
      )}
      <Grid position={[0, -1.5, 0]} args={[12, 12]} cellSize={0.5} cellThickness={0.35} cellColor="#1a2a3a" sectionSize={2} sectionThickness={0.7} sectionColor="#27445a" fadeDistance={9} infiniteGrid />
      <OrbitControls ref={controlsRef} enablePan minDistance={3} maxDistance={9} enableDamping dampingFactor={0.075} rotateSpeed={0.7} autoRotate={autoRotate && !playing} autoRotateSpeed={0.35}
        onStart={() => { manualInteraction.current = true; if (controlsRef.current) controlsRef.current.autoRotate = false; }}
        onEnd={() => { manualInteraction.current = false; }} />
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
  const [frameOpacity, setFrameOpacity] = useState(0.82);
  const [autoRotate, setAutoRotate] = useState(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("timeline");
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
  const selectedFrameIndex = useMemo(() => {
    if (!frames.length) return -1;
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    frames.forEach((frame, index) => {
      const distance = Math.abs(frame.time - currentTime);
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
    });
    return nearestIndex;
  }, [frames, currentTime]);
  const selectedFrame = selectedFrameIndex >= 0 ? frames[selectedFrameIndex] : null;
  const expectedFrameCount = duration > 0 ? Math.min(FRAME_COUNT, Math.max(2, Math.ceil(duration * 4))) : FRAME_COUNT;
  const selectFrame = useCallback((index: number) => {
    if (!frames.length) return;
    const safeIndex = THREE.MathUtils.clamp(index, 0, frames.length - 1);
    seek(frames[safeIndex].time);
  }, [frames, seek]);
  const playFromSelected = async () => {
    if (!video || !selectedFrame) return;
    seek(selectedFrame.time);
    try { await video.play(); setPlaying(true); }
    catch { setError("Playback was blocked. Try pressing play again."); }
  };
  const selectedPercent = selectedFrame && duration > 0 ? Math.round((selectedFrame.time / duration) * 100) : 0;
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void loadFile(event.target.files?.[0]);
    event.target.value = "";
  };

  return (
    <main className="app-shell" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void loadFile(event.dataTransfer.files?.[0]); }}>
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">◈</span> <span className="brand-name">4th Dimension</span></a>
        <div className="top-status"><span className="status-dot" /> LOCAL FILM STUDY</div>
        <button className="text-button" onClick={() => inputRef.current?.click()}>＋ Upload video</button>
      </header>

      <section className="hero">
        <div className="eyebrow"><span /> 4TH DIMENSION / TEMPORAL OBSERVATORY</div>
        <h1>Time, held<br /><em>in four dimensions.</em></h1>
        <p className="hero-copy">One continuous film, suspended in space.<br className="desktop-break" /> Turn the object. Scrub its depth. Watch time move.</p>
      </section>

      <section className="workspace">
        <div className="scene-panel">
          <div className="scene-topline">
            <div><span className="micro-label">TEMPORAL CUBE</span><span className="scene-name">{fileName || "Untitled temporal object"}</span></div>
            <div className="view-pill"><span className="status-dot" /> {loading ? "MAPPING SOURCE" : video ? "FILM IN SPACE" : "3D SPACE"}</div>
          </div>
          <div className="canvas-wrap">
            <Canvas camera={{ position: [3.6, 2.5, 4.5], fov: 43 }} dpr={[1, 1.5]}>
              <Scene video={video} frames={frames} duration={duration} depthScale={depthScale} frameOpacity={frameOpacity} autoRotate={autoRotate} playing={playing} playbackVideo={videoRef} onSeek={seek} resetKey={resetKey} controlsRef={controlsRef} />
            </Canvas>
            {!video && frames.length === 0 && !loading && (
              <div className="empty-overlay">
                <div className="upload-symbol">↥</div>
                <p className="empty-kicker">VOLUME / STANDBY</p>
                <p className="empty-title">The cube is waiting for a film.</p>
                <p className="empty-copy">Load a video to fill the volume with time.</p>
                <button className="primary-button" onClick={() => inputRef.current?.click()}>Load film <span>↗</span></button>
                <span className="file-hint">MP4 · WEBM · MOV · LOCAL ONLY</span>
              </div>
            )}
            {loading && <div className="loading-overlay"><div className="loading-ring" /><strong>Building the film volume</strong><span>{progress} of {expectedFrameCount} moments · processed on this device</span><div className="progress-track"><i style={{ width: `${(progress / expectedFrameCount) * 100}%` }} /></div></div>}
            <div className="canvas-hint"><span>↻</span> DRAG RAIL TO MOVE THROUGH TIME <span className="hint-divider">/</span> DRAG OUTSIDE TO ORBIT <span className="hint-divider">/</span> SCROLL TO ZOOM</div>
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
          <div className="panel-heading"><div><span className="micro-label">OBSERVATORY CONSOLE</span><strong className="console-title">Navigation</strong></div><span className="panel-index">{video ? "FILM LOADED" : "LOCAL / READY"}</span></div>
          <div className="mode-section">
            <span className="mode-label">INTERACTION MODE</span>
            <div className="mode-switcher" role="group" aria-label="Time interaction mode">
              <button className={interactionMode === "timeline" ? "selected" : ""} aria-pressed={interactionMode === "timeline"} onClick={() => setInteractionMode("timeline")}>Timeline</button>
              <button className={interactionMode === "slice" ? "selected" : ""} aria-pressed={interactionMode === "slice"} onClick={() => setInteractionMode("slice")}>Slice</button>
              <button className={interactionMode === "inspect" ? "selected" : ""} aria-pressed={interactionMode === "inspect"} onClick={() => setInteractionMode("inspect")}>Inspect</button>
            </div>
          </div>
          <div className="control-section">
            <div className="section-title">Source film <span className="step-number">01</span></div>
            <button className="upload-card" onClick={() => inputRef.current?.click()}>
              <span className="upload-card-icon">↥</span>
              <span className="upload-card-text"><strong>{fileName || "Choose a video"}</strong><small>{fileName ? "Click to replace source" : "Drop a file into this space"}</small></span>
              <span className="upload-arrow">↗</span>
            </button>
            {error && <p className="error-message">{error}</p>}
          </div>

          <div className="control-section">
            <div className="section-title">Time control <span className="step-number">02</span></div>
            <div className="time-readout"><strong>{formatTime(currentTime)}</strong><span>/ {formatTime(duration)}</span></div>
            <input aria-label="Video timeline" className="range-input" type="range" min={0} max={duration || 1} step={0.01} value={Math.min(currentTime, duration || 1)} disabled={!video || interactionMode === "slice" || interactionMode === "inspect"} onChange={e => seek(Number(e.target.value))} style={{ "--range-progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties} />
            <div className="range-labels"><span>BEGINNING</span><span>END</span></div>
            <div className="slice-control">
              <div className="depth-readout"><span>TIME SLICE</span><strong>{formatTime(currentTime)}</strong></div>
              <input aria-label="Time Slice position" className="range-input" type="range" min={0} max={duration || 1} step={0.01} value={Math.min(currentTime, duration || 1)} disabled={!video || interactionMode !== "slice"} onChange={event => seek(Number(event.target.value))} style={{ "--range-progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties} />
              <div className="range-labels"><span>SLICE POSITION</span><span>{selectedFrame ? `FRAME ${selectedFrameIndex + 1}` : "NO FRAME"}</span></div>
            </div>
            <div className="transport">
              <button title="Back one second" onClick={() => seek(Math.max(0, currentTime - 1))}>↶<small>1s</small></button>
              <button className="play-button" onClick={togglePlay}>{playing ? "Ⅱ" : "▶"}</button>
              <button title="Forward one second" onClick={() => seek(Math.min(duration, currentTime + 1))}>↷<small>1s</small></button>
            </div>
            <div className="speed-row"><label htmlFor="speed">Playback speed</label><select id="speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></div>
          </div>

          <div className="inspection-section">
            <div className="section-title">Frame index <span className="step-number">{interactionMode === "inspect" ? "ACTIVE" : "SAMPLES"}</span></div>
            {selectedFrame ? (
              <>
                <div className="inspection-card">
                  <FrameThumbnail frame={selectedFrame} />
                  <div className="inspection-meta"><strong>{formatTime(selectedFrame.time)}</strong><span>FRAME {selectedFrameIndex + 1} / {frames.length}</span><span>{selectedPercent}% ELAPSED</span></div>
                </div>
                <div className="frame-navigation"><button disabled={selectedFrameIndex <= 0} onClick={() => selectFrame(selectedFrameIndex - 1)}>← Previous</button><button disabled={selectedFrameIndex >= frames.length - 1} onClick={() => selectFrame(selectedFrameIndex + 1)}>Next →</button></div>
                <div className="inspection-actions"><button disabled={!video} onClick={() => selectFrame(selectedFrameIndex)}>Jump to Moment</button><button className="inspect-play" disabled={!video} onClick={() => void playFromSelected()}>Play From Here</button></div>
              </>
            ) : <div className="inspection-empty">Upload a video to inspect its sampled moments.</div>}
          </div>

          <div className="control-section visual-settings">
            <div className="section-title">Cube optics <span className="step-number">03</span></div>
            <div className="depth-readout"><span>TEMPORAL DEPTH</span><strong>{depthScale.toFixed(2)}×</strong></div>
            <input aria-label="Temporal depth" className="range-input depth-range" type="range" min={0.65} max={1.8} step={0.01} value={depthScale} onChange={event => setDepthScale(Number(event.target.value))} style={{ "--range-progress": `${((depthScale - 0.65) / 1.15) * 100}%` } as React.CSSProperties} />
            <div className="range-labels"><span>COMPRESS</span><span>EXPAND</span></div>
            <div className="depth-readout opacity-readout"><span>VIDEO PROJECTION</span><strong>{Math.round(frameOpacity * 100)}%</strong></div>
            <input aria-label="Frame opacity" className="range-input depth-range" type="range" min={0.15} max={1} step={0.01} value={frameOpacity} onChange={event => setFrameOpacity(Number(event.target.value))} style={{ "--range-progress": `${((frameOpacity - 0.15) / 0.85) * 100}%` } as React.CSSProperties} />
            <div className="setting-toggle-row"><span>Auto Rotate</span><button className={`setting-toggle${autoRotate ? " active" : ""}`} role="switch" aria-checked={autoRotate} onClick={() => setAutoRotate(value => !value)}><i /></button></div>
            <div className="property-row"><div><strong>Film projection</strong><small>Continuous playback</small></div><span className="property-value">{video ? "ACTIVE" : "STANDBY"}</span></div>
            <div className="property-row"><div><strong>Playback rate</strong><small>Timeline velocity</small></div><span className="property-value">{speed.toFixed(2)}×</span></div>
          </div>
          <div className="privacy-note"><span>◈</span><p><strong>Your footage stays local.</strong><br />Video frames are processed in your browser. Files are never uploaded.</p></div>
        </aside>
      </section>

      <footer className="footer"><span>4TH DIMENSION © 2026</span><span>ONE FILM · EVERY MOMENT</span><span>VIDEO STAYS LOCAL</span></footer>
      <input ref={inputRef} type="file" accept="video/*" hidden onChange={onFileChange} />
    </main>
  );
}
