import { useEffect, useRef, useState } from "react";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";
import "./styles.css";

const TOTAL_ROUNDS = 50;
const MIRROR = true;

const GESTURE_TARGETS = [
  // Open palm
  { type: "GESTURE", display: "🤚", label: "LEFT PALM", gesture: "OPEN_PALM", hand: "Left" },
  { type: "GESTURE", display: "✋", label: "RIGHT PALM", gesture: "OPEN_PALM", hand: "Right" },

  // Fist (left/right)
  { type: "GESTURE", display: "✊", label: "LEFT FIST", gesture: "FIST", hand: "Left" },
  { type: "GESTURE", display: "✊", label: "RIGHT FIST", gesture: "FIST", hand: "Right" },

  // Peace (left/right)
  { type: "GESTURE", display: "✌️", label: "LEFT PEACE", gesture: "PEACE", hand: "Left" },
  { type: "GESTURE", display: "✌️", label: "RIGHT PEACE", gesture: "PEACE", hand: "Right" },

  // Thumbs up (left/right)
  { type: "GESTURE", display: "👍", label: "LEFT THUMBS UP", gesture: "THUMBS_UP", hand: "Left" },
  { type: "GESTURE", display: "👍", label: "RIGHT THUMBS UP", gesture: "THUMBS_UP", hand: "Right" },

  // Rock sign (single hand - any hand)
  { type: "GESTURE", display: "🤘", label: "ROCK ON", gesture: "ROCKER" },

  // Both hands
  { type: "GESTURE", display: "🤘🤘", label: "BOTH HAND ROCK ON", gesture: "ROCKER", bothHands: true },
  { type: "GESTURE", display: "✊✊", label: "BOTH HAND FIST", gesture: "FIST", bothHands: true },
  { type: "GESTURE", display: "✌️✌️", label: "BOTH HAND PEACE", gesture: "PEACE", bothHands: true },
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
  const canvasRef = useRef(null);
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

  // Stable-frame gate (works for single-hand + both-hands)
  const matchStableCountRef = useRef(0);
  const STABLE_FRAMES = 3;

  const getElapsedMs = () => {
    if (!startedRef.current) return 0;
    return performance.now() - startAtRef.current;
  };

  const randomizeMousePos = () => {
    // avoid bottom-right camera preview zone
    const x = 10 + Math.random() * 60;
    const y = 15 + Math.random() * 55;
    setMousePos({ x, y });
  };

  const completeRound = () => {
    if (finishedRef.current) return;

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

    // reset stability gate when new target appears
    matchStableCountRef.current = 0;
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
      if (!finishedRef.current && startedRef.current) setTimeText(formatMs(getElapsedMs()));
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
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });

    hands.onResults((results) => {
      if (finishedRef.current) return;

      // draw camera frame into canvas
      const canvas = canvasRef.current;
      if (canvas && results.image) {
        const ctx = canvas.getContext("2d");
        const w = 640;
        const h = 480;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(results.image, 0, 0, w, h);
      }

      const t = targetRef.current;
      if (!t || t.type !== "GESTURE") return;

      const landmarks = results?.multiHandLandmarks || [];
      const handedness = results?.multiHandedness || [];

      // Build per-hand info
      const handsSeen = landmarks.map((lm, i) => {
        const rawHand = handedness?.[i]?.label || null; // "Left" / "Right"
        const seenHand = rawHand && MIRROR ? (rawHand === "Left" ? "Right" : "Left") : rawHand;
        const gesture = classifyGesture(lm);
        return { seenHand, gesture };
      });

      // Evaluate match
      let matched = false;

      if (t.bothHands) {
        // Need TWO hands doing the same gesture
        const valid = handsSeen.filter((h) => h.gesture);
        matched = valid.length === 2 && valid.every((h) => h.gesture === t.gesture);
      } else {
        // Single hand: (optionally) must be specific hand
        matched = handsSeen.some((h) => {
          if (!h.gesture) return false;
          if (h.gesture !== t.gesture) return false;
          if (t.hand) return h.seenHand === t.hand;
          return true;
        });
      }

      // Stability gate (3 frames)
      if (matched) matchStableCountRef.current += 1;
      else matchStableCountRef.current = 0;

      if (matchStableCountRef.current >= STABLE_FRAMES) {
        matchStableCountRef.current = 0;
        completeRound();
      }
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
      try {
        cameraRef.current?.stop();
      } catch {}
      try {
        hands.close();
      } catch {}
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

    matchStableCountRef.current = 0;
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

      {/* input only (hidden) */}
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

      {/* camera preview */}
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

  // 🤘 Rocker: index + pinky extended, middle + ring curled
  if (indexExt && !middleExt && !ringExt && pinkyExt && middleCurl && ringCurl) return "ROCKER";

  return null;
}