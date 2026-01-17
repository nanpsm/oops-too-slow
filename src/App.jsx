import { useEffect, useRef, useState } from "react";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";
import "./styles.css";

// --- Firebase (ALL in this file) ---
import {
  getAuth,
  signInAnonymously,
  updateProfile,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  runTransaction,
  serverTimestamp,
} from "firebase/database";
import { auth, db } from "./firebase";
import { setPersistence, inMemoryPersistence } from "firebase/auth";
import { onDisconnect } from "firebase/database";

// --- Game constants ---
const TOTAL_ROUNDS_DEFAULT = 20;
const MIRROR = true;

const GESTURE_TARGETS = [
  { type: "GESTURE", display: "🤚", label: "LEFT PALM", gesture: "OPEN_PALM", hand: "Left" },
  { type: "GESTURE", display: "✋", label: "RIGHT PALM", gesture: "OPEN_PALM", hand: "Right" },

  { type: "GESTURE", display: "✊", label: "LEFT FIST", gesture: "FIST", hand: "Left" },
  { type: "GESTURE", display: "✊", label: "RIGHT FIST", gesture: "FIST", hand: "Right" },

  { type: "GESTURE", display: "✌️", label: "LEFT PEACE", gesture: "PEACE", hand: "Left" },
  { type: "GESTURE", display: "✌️", label: "RIGHT PEACE", gesture: "PEACE", hand: "Right" },

  { type: "GESTURE", display: "👍", label: "LEFT THUMBS UP", gesture: "THUMBS_UP", hand: "Left" },
  { type: "GESTURE", display: "👍", label: "RIGHT THUMBS UP", gesture: "THUMBS_UP", hand: "Right" },

  { type: "GESTURE", display: "🤘", label: "ROCK ON", gesture: "ROCKER" },

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

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms));
  const sec = Math.floor(total / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const msLeft = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(msLeft).padStart(3, "0")}`;
}

// ---------- Deterministic RNG for TEAM mode (same targets for everyone) ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generateKeyTargetFromRng(rng) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const symbols = "`-=[]\\;',./";
  const all = (letters + numbers + symbols + " ").split("");
  const key = all[Math.floor(rng() * all.length)];
  return {
    type: "KEY",
    key,
    display: key === " " ? "␣" : key.toUpperCase(),
    label: key === " " ? "SPACE" : "PRESS KEY",
  };
}

function mousePosFromRng(rng) {
  // avoid bottom-right camera preview zone (same style as yours)
  const x = 10 + rng() * 60;
  const y = 15 + rng() * 55;
  return { x, y };
}

function pickTargetForRound({ seed, roundIndex }) {
  // Make result depend on BOTH seed and roundIndex (stable per round)
  const rng = mulberry32((seed ^ (roundIndex * 2654435761)) >>> 0);

  const r = rng();
  if (r < 0.34) {
    return GESTURE_TARGETS[Math.floor(rng() * GESTURE_TARGETS.length)];
  }
  if (r < 0.67) return generateKeyTargetFromRng(rng);
  return { type: "MOUSE", display: "🎯", label: "CLICK THE TARGET" };
}

// ---------- Firebase helpers (still in same file) ----------
async function signInWithName(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Please enter a name");

  const cred = await signInAnonymously(auth);
  return cred.user;
}

function makeRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function createRoom(roundCount = TOTAL_ROUNDS_DEFAULT, playerName = "Host") {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const safeName = (playerName || "").trim() || "Host";

  for (let tries = 0; tries < 5; tries++) {
    const code = makeRoomCode(6);
    const roomRef = ref(db, `rooms/${code}`);

    const snap = await get(roomRef);
    if (snap.exists()) continue;

    const roundSeed = Math.floor(Math.random() * 1_000_000_000);

    await set(roomRef, {
      hostUid: user.uid,
      status: "lobby",
      createdAt: serverTimestamp(),
      maxPlayers: 5,
      playerCount: 1,
      roundCount,
      roundSeed,
      startedAt: null,
      players: {
        [user.uid]: {
          name: safeName,
          joinedAt: serverTimestamp(),
          finished: false,
          totalTimeMs: null,
        },
      },
    });

    // onDisconnect cleanup (FIXED uid)
    onDisconnect(ref(db, `rooms/${code}/players/${user.uid}`)).remove();
    onDisconnect(ref(db, `rooms/${code}/results/${user.uid}`)).remove();

    return code;
  }
  throw new Error("Failed to create room. Try again.");
}


async function joinRoom(code, playerName = "Player") {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const safeName = (playerName || "").trim() || "Player";

  const roomRef = ref(db, `rooms/${code}`);
  const roomSnap = await get(roomRef);
  if (!roomSnap.exists()) throw new Error("Room not found");

  const room = roomSnap.val();
  if (room.status !== "lobby") throw new Error("Game already started");

  // rejoin without consuming slot
  if (room.players && room.players[user.uid]) {
    // still register cleanup
    onDisconnect(ref(db, `rooms/${code}/players/${user.uid}`)).remove();
    onDisconnect(ref(db, `rooms/${code}/results/${user.uid}`)).remove();
    return true;
  }

  // max 5 enforcement
  const countRef = ref(db, `rooms/${code}/playerCount`);
  const tx = await runTransaction(countRef, (cur) => {
    const n = typeof cur === "number" ? cur : 0;
    if (n >= 5) return; // abort
    return n + 1;
  });
  if (!tx.committed) throw new Error("Room full (max 5)");

  await update(ref(db, `rooms/${code}/players/${user.uid}`), {
    name: safeName,
    joinedAt: serverTimestamp(),
    finished: false,
    totalTimeMs: null,
  });

  onDisconnect(ref(db, `rooms/${code}/players/${user.uid}`)).remove();
  onDisconnect(ref(db, `rooms/${code}/results/${user.uid}`)).remove();

  return true;
}

async function startGame(code) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const roomRef = ref(db, `rooms/${code}`);
  const snap = await get(roomRef);
  if (!snap.exists()) throw new Error("Room not found");

  const room = snap.val();
  if (room.hostUid !== user.uid) throw new Error("Only host can start");
  if (room.status !== "lobby") throw new Error("Already started");

  await update(roomRef, { status: "playing", startedAt: serverTimestamp() });
}

async function submitResult(code, totalTimeMs) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const ms = Math.max(0, Math.floor(totalTimeMs));
  const updates = {};
  updates[`rooms/${code}/players/${user.uid}/finished`] = true;
  updates[`rooms/${code}/players/${user.uid}/totalTimeMs`] = ms;
  updates[`rooms/${code}/results/${user.uid}`] = ms;

  await update(ref(db), updates);
}

function listenRoom(code, cb) {
  const roomRef = ref(db, `rooms/${code}`);
  return onValue(roomRef, (snap) => cb(snap.val()));
}

// -------------------- APP --------------------
export default function App() {
  useEffect(() => {
  setPersistence(auth, inMemoryPersistence).catch(console.error);
  }, []);

  const [screen, setScreen] = useState("name");
  const [name, setName] = useState("");
  const [authUser, setAuthUser] = useState(null);

  const [mode, setMode] = useState(null); 
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [roomData, setRoomData] = useState(null);
  const unsubRef = useRef(null);

  const [roundsChoice, setRoundsChoice] = useState(20);
  const [showSettings, setShowSettings] = useState(false);

  // TEAM game settings from room
  const [roundSeed, setRoundSeed] = useState(null);
  const [totalRounds, setTotalRounds] = useState(TOTAL_ROUNDS_DEFAULT);

  // --- Your existing refs ---
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [round, setRound] = useState(1);
  const [target, setTarget] = useState(() => pickTargetForRound({ seed: 123, roundIndex: 1 })); // will reset properly
  const [finished, setFinished] = useState(false);

  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });

  // Total time (sum of per-round durations) — what you asked for
  const totalMsRef = useRef(0);
  const roundStartRef = useRef(0);
  const startedRef = useRef(false);
  const lastRoomStatusRef = useRef(null);
  const startedAtRef = useRef(null); // prevents reset on every update
  const [timeText, setTimeText] = useState("0:00.000");

  // Avoid stale state inside handlers
  const targetRef = useRef(target);
  const roundRef = useRef(round);
  const finishedRef = useRef(finished);

  useEffect(() => void (targetRef.current = target), [target]);
  useEffect(() => void (roundRef.current = round), [round]);
  useEffect(() => void (finishedRef.current = finished), [finished]);

  // Stable-frame gate
  const matchStableCountRef = useRef(0);
  const STABLE_FRAMES = 3;

  // Keep auth user state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthUser(u);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Target generator wrapper (solo = random, team = deterministic) ---
  function getNextTarget(nextRound) {
    if (mode === "team" && roundSeed != null) {
      return pickTargetForRound({ seed: roundSeed, roundIndex: nextRound });
    }
    // SOLO: keep your old randomness style
    // (use Math.random but still reuse deterministic functions for simplicity)
    const rng = () => Math.random();
    const r = rng();
    if (r < 0.34) return GESTURE_TARGETS[Math.floor(rng() * GESTURE_TARGETS.length)];
    if (r < 0.67) return generateKeyTargetFromRng(rng);
    return { type: "MOUSE", display: "🎯", label: "CLICK THE TARGET" };
  }

  function getMousePosForTarget(nextRound) {
    if (mode === "team" && roundSeed != null) {
      const rng = mulberry32((roundSeed ^ (nextRound * 97531)) >>> 0);
      return mousePosFromRng(rng);
    }
    // SOLO random
    const x = 10 + Math.random() * 60;
    const y = 15 + Math.random() * 55;
    return { x, y };
  }

  const getDisplayedMs = () => {
    if (!startedRef.current) return 0;
    const now = performance.now();
    return totalMsRef.current + (now - roundStartRef.current);
  };

  // Complete round: add per-round time, advance, finish
  const completeRound = async () => {
    if (finishedRef.current) return;

    const now = performance.now();
    if (!startedRef.current) {
      startedRef.current = true;
      roundStartRef.current = now;
      totalMsRef.current = 0;
    } else {
      // close current round
      totalMsRef.current += now - roundStartRef.current;
      roundStartRef.current = now;
    }

    // finish?
    if (roundRef.current >= totalRounds) {
      const finalMs = totalMsRef.current;
      setTimeText(formatMs(finalMs));
      setFinished(true);

      // TEAM: submit result
      if (mode === "team" && roomCode) {
        try {
          await submitResult(roomCode, finalMs);
          setScreen("results");
        } catch (e) {
          console.error(e);
          setScreen("results"); // still show results screen
        }
      } else {
        setScreen("results");
      }
      return;
    }

    // next round
    setRound((r) => {
      const nextR = r + 1;
      const nextT = getNextTarget(nextR);
      setTarget(nextT);
      if (nextT.type === "MOUSE") setMousePos(getMousePosForTarget(nextR));
      matchStableCountRef.current = 0;
      return nextR;
    });
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
      if (!finishedRef.current && startedRef.current) setTimeText(formatMs(getDisplayedMs()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard input
  useEffect(() => {
    const onKeyDown = (e) => {
      if (finishedRef.current) return;
      if (screen !== "game") return;
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
  }, [screen]);

  // MediaPipe Hands + camera preview
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

      // draw camera frame
      const canvas = canvasRef.current;
      if (canvas && results.image) {
        const ctx = canvas.getContext("2d");
        const w = 640;
        const h = 480;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(results.image, 0, 0, w, h);
      }

      if (screen !== "game") return;

      const t = targetRef.current;
      if (!t || t.type !== "GESTURE") return;

      const landmarks = results?.multiHandLandmarks || [];
      const handedness = results?.multiHandedness || [];

      const handsSeen = landmarks.map((lm, i) => {
        const rawHand = handedness?.[i]?.label || null;
        const seenHand = rawHand && MIRROR ? (rawHand === "Left" ? "Right" : "Left") : rawHand;
        const gesture = classifyGesture(lm);
        return { seenHand, gesture };
      });

      let matched = false;

      if (t.bothHands) {
        const valid = handsSeen.filter((h) => h.gesture);
        matched = valid.length === 2 && valid.every((h) => h.gesture === t.gesture);
      } else {
        matched = handsSeen.some((h) => {
          if (!h.gesture) return false;
          if (h.gesture !== t.gesture) return false;
          if (t.hand) return h.seenHand === t.hand;
          return true;
        });
      }

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
      try { cameraRef.current?.stop(); } catch {}
      try { hands.close(); } catch {}
    };
  }, [screen]);

  // TEAM: listen to room changes
  function startListening(code) {
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = listenRoom(code, (data) => {
      setRoomData(data || null);

      // when host starts
      const newStatus = data?.status || null;
      const prevStatus = lastRoomStatusRef.current;
      lastRoomStatusRef.current = newStatus;

      // ONLY start/reset when it just changed to "playing"
      const justStarted =
        newStatus === "playing" &&
        (prevStatus !== "playing" || startedAtRef.current !== data?.startedAt);

      if (justStarted && screen !== "results") {
        startedAtRef.current = data?.startedAt || null;

        setMode("team");
        setRoundSeed(data.roundSeed);
        setTotalRounds(data.roundCount || TOTAL_ROUNDS_DEFAULT);

        resetGame({ seed: data.roundSeed, rounds: data.roundCount || TOTAL_ROUNDS_DEFAULT });
        setScreen("game");
      }

    });
  }

  useEffect(() => {
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  // Reset game function
  function resetGame({ seed = null, rounds = TOTAL_ROUNDS_DEFAULT } = {}) {
    setFinished(false);
    setTotalRounds(rounds);
    setRound(1);

    const next = seed != null ? pickTargetForRound({ seed, roundIndex: 1 }) : getNextTarget(1);
    setTarget(next);
    if (next.type === "MOUSE") setMousePos(seed != null ? getMousePosForTarget(1) : getMousePosForTarget(1));

    setTimeText("0:00.000");
    startedRef.current = false;
    totalMsRef.current = 0;
    roundStartRef.current = 0;
    matchStableCountRef.current = 0;
  }

  // ----- UI actions -----
  async function handleNameContinue() {
    try {
      await signInWithName(name);
      setScreen("mode");
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  function goSolo() {
    setMode("solo");
    setRoomCode("");
    setRoomData(null);
    setRoundSeed(null);

    setTotalRounds(roundsChoice);
    resetGame({ seed: null, rounds: roundsChoice });
    setScreen("game");
  }

  function goTeam() {
    setMode("team");
    setScreen("teamChoice");
  }

  async function handleHostCreate() {
    try {
      const code = await createRoom(roundsChoice, name);
      setRoomCode(code);
      startListening(code);
      setScreen("lobby");
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  async function handleJoin() {
    try {
      const code = joinCode.trim().toUpperCase();
      if (!code) return alert("Enter room code");
      await joinRoom(code, name);
      setRoomCode(code);
      startListening(code);
      setScreen("lobby");
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  async function handleHostStart() {
    try {
      await startGame(roomCode);
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  function handleBackHome() {
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = null;

    setRoomData(null);
    setRoomCode("");
    setJoinCode("");
    setRoundSeed(null);
    setMode(null);
    setScreen("mode");
  }

  function buildLeaderboard() {
    const results = roomData?.results || {};
    const players = roomData?.players || {};
    const rows = Object.entries(results).map(([uid, ms]) => ({
      uid,
      name: players?.[uid]?.name || "Player",
      ms: typeof ms === "number" ? ms : Number(ms),
    }));
    rows.sort((a, b) => a.ms - b.ms);
    return rows;
  }

  if (screen === "name") {
    return (
      <div className="minScreen" style={{ padding: 18 }}>
        <h2>Oops! Too Slow</h2>
        <p>Enter your nickname:</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your nickname"
          style={{ padding: 10, fontSize: 16, width: 260 }}
        />
        <div style={{ height: 10 }} />
        <button className="hudBtn" onClick={handleNameContinue}>
          Continue
        </button>
        <div style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
          You’ll be signed in anonymously (no email/password).
        </div>
      </div>
    );
  }

  if (screen === "mode") {
    return (
      <div className="minScreen" style={{ padding: 18, position: "relative" }}>
        <h2>Hi, {name || "Player"} 👋</h2>
        <p>Choose a mode:</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="hudBtn" onClick={goSolo}>Solo Mode</button>
          <button className="hudBtn" onClick={goTeam}>Team Mode</button>
        </div>
        <button
          onClick={() => setShowSettings((v) => !v)}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            border: "none",
            background: "transparent",
            fontSize: 20,
            cursor: "pointer",
          }}
          aria-label="Settings"
        >
          ⚙️
        </button>

        {showSettings && (
          <div
            style={{
              position: "absolute",
              top: 44,
              right: 12,
              padding: 12,
              borderRadius: 12,
              background: "rgba(0,0,0,0.85)",
              color: "white",
              width: 220,
            }}
          >
          <div style={{ marginBottom: 10, fontWeight: 700, fontSize: 18 }}>
            Game Rounds
          </div>

          <input
            type="range"
            min={10}
            max={50}
            step={10}
            value={roundsChoice}
            onChange={(e) => setRoundsChoice(Number(e.target.value))}
            style={{ width: "100%" }}
          />

          <div style={{ marginTop: 10 }}>
            <b>{roundsChoice}</b> Rounds
          </div>
      </div>
    )}
      </div>
    );
  }

  if (screen === "teamChoice") {
    return (
      <div className="minScreen" style={{ padding: 18 }}>
        <h2>Team Mode</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="hudBtn" onClick={handleHostCreate}>Host Game</button>
          <button className="hudBtn" onClick={() => setScreen("join")}>Join Party</button>
          <button className="hudBtn" onClick={handleBackHome}>Back</button>
        </div>
        <p style={{ marginTop: 12, opacity: 0.8 }}>
          Party limit: <b>5 players</b>
        </p>
      </div>
    )
  }

  if (screen === "join") {
    return (
      <div className="minScreen" style={{ padding: 18 }}>
        <h2>Join Party</h2>
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          placeholder="Room code (e.g. AB12CD)"
          style={{ padding: 10, fontSize: 16, width: 260, textTransform: "uppercase" }}
        />
        <div style={{ height: 10 }} />
        <div style={{ display: "flex", gap: 10 }}>
          <button className="hudBtn" onClick={handleJoin}>Join</button>
          <button className="hudBtn" onClick={() => setScreen("teamChoice")}>Back</button>
        </div>
      </div>
    );
  }

  if (screen === "lobby") {
    const players = roomData?.players ? Object.values(roomData.players) : [];
    const isHost = roomData?.hostUid && auth.currentUser?.uid === roomData.hostUid;

    return (
      <div className="minScreen" style={{ padding: 18 }}>
        <h2>Waiting Room</h2>
        <div style={{ marginBottom: 8 }}>
          Room Code: <b style={{ letterSpacing: 2 }}>{roomCode}</b>
        </div>
        <div style={{ opacity: 0.8, marginBottom: 12 }}>
          Players ({players.length}/5):
        </div>
        <ul>
          {players.map((p, i) => (
            <li key={i}>{p.name}{p.finished ? " ✅" : ""}</li>
          ))}
        </ul>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          {isHost ? (
            <button className="hudBtn" onClick={handleHostStart}>
              Start Game
            </button>
          ) : (
            <div style={{ opacity: 0.8 }}>Waiting for host to start…</div>
          )}
          <button className="hudBtn" onClick={handleBackHome}>Leave</button>
        </div>
      </div>
    );
  }

  if (screen === "results") {
    const isTeam = mode === "team" && roomData;
    const rows = isTeam ? buildLeaderboard() : [];

    return (
      <div className="minScreen" style={{ padding: 18 }}>
        <h2>Results</h2>

        {mode === "solo" && (
          <>
            <p>Your total time:</p>
            <h3>{timeText}</h3>
          </>
        )}

        {isTeam && (
          <>
            <p>Leaderboard (fastest wins):</p>
            {rows.length === 0 ? (
              <div style={{ opacity: 0.8 }}>No results yet…</div>
            ) : (
              <ol>
                {rows.map((r) => (
                  <li key={r.uid}>
                    <b>{r.name}</b> — {formatMs(r.ms)}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <button
            className="hudBtn"
            onClick={() => {
              if (mode === "team") {
                // In team mode, wait room still exists; go back to lobby
                setFinished(false);
                setScreen(roomCode ? "lobby" : "mode");
              } else {
                // Solo restart
                goSolo();
              }
            }}
          >
            {mode === "team" ? "Back to Lobby" : "Play Again"}
          </button>
          <button className="hudBtn" onClick={handleBackHome}>Home</button>
        </div>
      </div>
    );
  }

  // -------------- GAME SCREEN (your original UI, slightly adjusted) --------------
  // Note: in TEAM mode, seed/roundCount is controlled by host start.
  const TOTAL_ROUNDS = totalRounds;

  const reset = () => {
    if (mode === "team") {
      // For team, don’t let people desync by random reset during a match.
      // Just reset locally to round 1 with same seed.
      resetGame({ seed: roundSeed, rounds: TOTAL_ROUNDS });
    } else {
      resetGame({ seed: null, rounds: TOTAL_ROUNDS_DEFAULT });
    }
  };

  return (
    <div className="minScreen">
      <div className="hud">
        <div>{ready ? "CAM ON" : "CAM..."}</div>
        <div>
          {mode === "team" ? (
            <>ROOM: <b>{roomCode}</b> | </>
          ) : null}
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

// Gesture classifier (unchanged)
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

  if (indexExt && !middleExt && !ringExt && pinkyExt && middleCurl && ringCurl) return "ROCKER";

  return null;
}