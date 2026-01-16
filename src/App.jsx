import { useEffect, useRef, useState } from "react";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";
import "./styles.css";

const TOTAL_ROUNDS = 20;
const MIRROR = true;

const GESTURE_TARGETS = [
  { type: "GESTURE", display: "🤚", label: "LEFT PALM", gesture: "OPEN_PALM", hand: "Left" },
  { type: "GESTURE", display: "✋", label: "RIGHT PALM", gesture: "OPEN_PALM", hand: "Right" },
  { type: "GESTURE", display: "✊", label: "FIST", gesture: "FIST" },
  { type: "GESTURE", display: "✌️", label: "PEACE", gesture: "PEACE" },
  { type: "GESTURE", display: "👍", label: "THUMBS UP", gesture: "THUMBS_UP" },
];

const EXCLUDED_KEYS = ["Meta", "Control", "Alt", "Shift", "Escape", "CapsLock", "Tab"];
function isAllowedKey(key) {
  if (EXCLUDED_KEYS.includes(key)) return false;
  if (typeof key === "string" && key.startsWith("F")) return false;
  return true;
}

function generateRandomKeyTarget() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const symbols = "`-=[]\\;',./";
  const all = (letters + numbers + symbols + " ").split("");

  const key = all[Math.floor(Math.random() * all.length)];
  return {
    type: "KEY",
    key,
    display: key === " " ? "␣" : key.toUpperCase(),
    label: key === " " ? "SPACE" : "PRESS KEY",
  };
}

function generateRandomMouseTarget() {
  return { type: "MOUSE", display: "🎯", label: "CLICK THE TARGET" };
}

function pickNextTarget() {
  const r = Math.random();
  if (r < 0.34) return GESTURE_TARGETS[Math.floor(Math.random() * GESTURE_TARGETS.length)];
  if (r < 0.67) return generateRandomKeyTarget();
  return generateRandomMouseTarget();
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms));
  const sec = Math.floor(total / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const msLeft = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(msLeft).padStart(3, "0")}`;
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);          // ✅ FIX: declare this
  const cameraRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [round, setRound] = useState(1);
  const [target, setTarget] = useState(() => pickNextTarget());
  const [finished, setFinished] = useState(false);

  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const startAtRef = useRef(0);
  const [timeText, setTimeText] = useState("0:00.000");
  const startedRef = useRef(false);

  // Avoid stale state inside handlers
  const targetRef = useRef(target);
  const roundRef = useRef(round);
  const finishedRef = useRef(finished);

  useEffect(() => void (targetRef.current = target), [target]);
  useEffect(() => void (roundRef.current = round), [round]);
  useEffect(() => void (finishedRef.current = finished), [finished]);

  // Gesture smoothing
  const lastRawGestureRef = useRef(null);
  const stableGestureRef = useRef(null);
  const stableCountRef = useRef(0);

  const getElapsedMs = () => {
    if (!startedRef.current) return 0;
    return performance.now() - startAtRef.current;
  };

  const randomizeMousePos = () => {
    const x = 10 + Math.random() * 80;
    const y = 15 + Math.random() * 70;
    setMousePos({ x, y });
  };

  const completeRound = () => {
    if (finishedRef.current) return;

    // start timer on first correct
    if (!startedRef.current) {
      startedRef.current = true;
      startAtRef.current = performance.now();
    }

    if (roundRef.current >= TOTAL_ROUNDS) {
      setTimeText(formatMs(getElapsedMs()));
      setFinished(true);
      return;
    }

    setRound((r) => r + 1);
    const next = pickNextTarget();
    setTarget(next);
    if (next.type === "MOUSE") randomizeMousePos();
  };

  const onMouseTargetClick = (e) => {
    e.stopPropagation();
    if (finishedRef.current) return;
    if (targetRef.current?.type !== "MOUSE") return;
    completeRound();
  };

  // Live timer display
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (!finishedRef.current && startedRef.current) {
        setTimeText(formatMs(getElapsedMs()));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard input
  useEffect(() => {
    const onKeyDown = (e) => {
      if (finishedRef.current) return;
      if (e.repeat) return;
      if (!isAllowedKey(e.key)) return;

      const t = targetRef.current;
      if (!t || t.type !== "KEY") return;

      const pressed = String(e.key).toLowerCase();
      const expected = String(t.key).toLowerCase();

      if (pressed === expected) completeRound();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // MediaPipe Hands + draw preview onto canvas
  useEffect(() => {
    if (!videoRef.current) return;

    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });

    hands.onResults((results) => {
      if (finishedRef.current) return;

      // ✅ draw camera frame into your bottom-right canvas
      const canvas = canvasRef.current;
      if (canvas && results.image) {
        const ctx = canvas.getContext("2d");
        const w = 640;
        const h = 480;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(results.image, 0, 0, w, h);
      }

      const lm = results?.multiHandLandmarks?.[0] || null;
      const handed = results?.multiHandedness?.[0]?.label || null;

      const raw = classifyGesture(lm) ?? null;

      if (raw === lastRawGestureRef.current) stableCountRef.current += 1;
      else {
        lastRawGestureRef.current = raw;
        stableCountRef.current = 1;
      }

      const STABLE_FRAMES = 3;
      if (stableCountRef.current >= STABLE_FRAMES) stableGestureRef.current = raw;

      const stable = stableGestureRef.current;
      if (!stable) return;

      const seenHand = handed && MIRROR ? (handed === "Left" ? "Right" : "Left") : handed;

      const t = targetRef.current;
      if (!t || t.type !== "GESTURE") return;

      const gestureOk = stable === t.gesture;
      const handOk = t.hand ? seenHand === t.hand : true;

      if (gestureOk && handOk) completeRound();
    });

    cameraRef.current = new Camera(videoRef.current, {
      onFrame: async () => {
        await hands.send({ image: videoRef.current });
      },
      width: 640,
      height: 480,
    });

    cameraRef.current.start();
    setReady(true);

    return () => {
      try { cameraRef.current?.stop(); } catch {}
      try { hands.close(); } catch {}
    };
  }, []);

  const reset = () => {
    setFinished(false);
    setRound(1);

    const next = pickNextTarget();
    setTarget(next);
    if (next.type === "MOUSE") randomizeMousePos();

    setTimeText("0:00.000");
    startedRef.current = false;

    lastRawGestureRef.current = null;
    stableGestureRef.current = null;
    stableCountRef.current = 0;
  };

  return (
    <div className="minScreen">
      <div className="hud">
        <div>{ready ? "CAM ON" : "CAM..."}</div>
        <div>
          ROUND: <b>{round}/{TOTAL_ROUNDS}</b> | TIME: <b>{timeText}</b>
        </div>
        <button className="hudBtn" onClick={reset}>Reset</button>
      </div>

      {/* ✅ input only (hidden) */}
      <video ref={videoRef} className="hiddenVideo" autoPlay playsInline muted />

      <div className="centerWrap">
        {(target.type === "KEY" || target.type === "GESTURE") && (
          <div className="targetBox">
            <div className="big">{target.display}</div>
            <div className="subtitle">{target.label}</div>
          </div>
        )}

        {target.type === "MOUSE" && (
          <button
            className="mouseTarget"
            style={{ left: `${mousePos.x}%`, top: `${mousePos.y}%` }}
            onClick={onMouseTargetClick}
            aria-label="Click target"
          />
        )}
      </div>

      {/* ✅ this now shows the camera because we draw into it */}
      <canvas ref={canvasRef} className="cameraPreview" />
    </div>
  );
}

// Gesture classifier
function classifyGesture(lm) {
  if (!lm) return null;

  const fingerExtended = (mcp, pip, tip) => lm[tip].y < lm[pip].y && lm[pip].y < lm[mcp].y;
  const fingerCurled = (pip, tip) => lm[tip].y > lm[pip].y;

  const indexExt = fingerExtended(5, 6, 8);
  const middleExt = fingerExtended(9, 10, 12);
  const ringExt = fingerExtended(13, 14, 16);
  const pinkyExt = fingerExtended(17, 18, 20);

  const indexCurl = fingerCurled(6, 8);
  const middleCurl = fingerCurled(10, 12);
  const ringCurl = fingerCurled(14, 16);
  const pinkyCurl = fingerCurled(18, 20);

  const extendedCount = [indexExt, middleExt, ringExt, pinkyExt].filter(Boolean).length;

  const thumbUp = lm[4].y < lm[3].y && lm[3].y < lm[2].y;
  const thumbAboveWrist = lm[4].y < lm[0].y;

  if (extendedCount === 4) return "OPEN_PALM";
  if (indexExt && middleExt && !ringExt && !pinkyExt) return "PEACE";
  if (thumbUp && thumbAboveWrist && indexCurl && middleCurl && ringCurl && pinkyCurl) return "THUMBS_UP";
  if (extendedCount === 0 && !thumbUp) return "FIST";

  return null;
}