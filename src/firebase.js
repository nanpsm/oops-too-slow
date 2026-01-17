// src/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, updateProfile } from "firebase/auth";
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


// 1) Firebase config (yours)
const firebaseConfig = {
  apiKey: "AIzaSyBAe7YjawmZEk8t1HLeAt6DZoB2DRwv7-w",
  authDomain: "oops-too-slow.firebaseapp.com",
  projectId: "oops-too-slow",
  databaseURL: "https://oops-too-slow-default-rtdb.asia-southeast1.firebasedatabase.app",
  storageBucket: "oops-too-slow.firebasestorage.app",
  messagingSenderId: "120862424624",
  appId: "1:120862424624:web:0692b1cea858ae65ed37f5",
};

// 2) Init
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// ---------- helpers (kept in same file) ----------

export async function signInWithName(name) {
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

export async function startGame(code) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const roomRef = ref(db, `rooms/${code}`);
  const snap = await get(roomRef);
  if (!snap.exists()) throw new Error("Room not found");

  const room = snap.val();
  if (room.hostUid !== user.uid) throw new Error("Only host can start");
  if (room.status !== "lobby") throw new Error("Already started");

  await update(roomRef, {
    status: "playing",
    startedAt: serverTimestamp(),
  });
}

export async function submitResult(code, totalTimeMs) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const ms = Math.max(0, Math.floor(totalTimeMs));

  const updates = {};
  updates[`rooms/${code}/players/${user.uid}/finished`] = true;
  updates[`rooms/${code}/players/${user.uid}/totalTimeMs`] = ms;
  updates[`rooms/${code}/results/${user.uid}`] = ms;

  await update(ref(db), updates);
}

export function listenRoom(code, cb) {
  const roomRef = ref(db, `rooms/${code}`);
  return onValue(roomRef, (snap) => cb(snap.val()));
}
