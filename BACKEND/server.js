const fs = require("fs");
const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { DateTime } = require("luxon");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "./data";
const TZ_DEFAULT = process.env.TZ_DEFAULT || "America/Mexico_City";

// --- Ensure data dir exists ---
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "pill.db");

// --- SQLite helpers (promisified) ---
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// --- Init tables ---
async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      tz TEXT NOT NULL DEFAULT '${TZ_DEFAULT}'
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS schedules (
      device_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      PRIMARY KEY (device_id, slot),
      FOREIGN KEY (device_id) REFERENCES devices(device_id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS taken_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,          -- epoch seconds
      created_at INTEGER NOT NULL,  -- epoch seconds
      FOREIGN KEY (device_id) REFERENCES devices(device_id)
    );
  `);

  // indexes
  await run(`CREATE INDEX IF NOT EXISTS idx_taken_device_ts ON taken_events(device_id, ts);`);
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

/**
 * Compute risk of missing next dose for this (device, hour, minute).
 * Uses last N days expected doses inferred from schedule & taken_events.
 *
 * - If a scheduled dose is in the past (scheduled + grace <= now), it's "expected".
 * - It's "taken" if there's a taken_event in [scheduled - earlyWindow, scheduled + grace].
 * - Weighted by decay^(days_ago) so recent days count more.
 */
async function computeRisk({ deviceId, tz, hour, minute }) {
  const now = DateTime.now().setZone(tz);
  const lookbackDays = 14;
  const graceMin = 60;       // after schedule time, still counts as taken
  const earlyMin = 10;       // allow slightly early confirmations
  const decay = 0.93;        // recency weighting

  // pull taken events for a bit more than lookback
  const since = now.minus({ days: lookbackDays + 2 }).toSeconds();
  const takenRows = await all(
    `SELECT ts FROM taken_events WHERE device_id=? AND ts>=? ORDER BY ts ASC`,
    [deviceId, Math.floor(since)]
  );
  const takenTs = takenRows.map(r => r.ts);

  // helper: check if any taken event is within [a,b]
  function hasTakenInWindow(aSec, bSec) {
    // takenTs is sorted; linear scan is ok for small volumes
    // but we’ll do a simple binary-ish scan
    let lo = 0, hi = takenTs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (takenTs[mid] < aSec) lo = mid + 1;
      else hi = mid - 1;
    }
    // lo is first >= aSec
    return lo < takenTs.length && takenTs[lo] <= bSec;
  }

  let wTaken = 0;
  let wMiss = 0;

  for (let d = 0; d < lookbackDays; d++) {
    const day = now.startOf("day").minus({ days: d });
    const sched = day.set({ hour, minute, second: 0, millisecond: 0 });
    const due = sched.plus({ minutes: graceMin });

    // only count if it's already due in the past
    if (due > now) continue;

    const weight = Math.pow(decay, d);
    const aSec = Math.floor(sched.minus({ minutes: earlyMin }).toSeconds());
    const bSec = Math.floor(due.toSeconds());

    if (hasTakenInWindow(aSec, bSec)) wTaken += weight;
    else wMiss += weight;
  }

  // Beta prior (stabilizes small data)
  const alpha0 = 3.0;
  const beta0 = 1.5;

  const pTake = (alpha0 + wTaken) / (alpha0 + beta0 + wTaken + wMiss);
  const risk = clamp(1 - pTake, 0, 1);

  return { risk, pTake, wTaken, wMiss };
}

/** Map risk -> reminder policy fields used by firmware */
function policyFromRisk(risk) {
  const preMin = clamp(Math.round(5 + risk * 25), 5, 30);     // 5..30
  const nag = clamp(Math.round(risk * 3), 0, 3);              // 0..3
  const repeatEveryMin =
    risk < 0.45 ? 0 :
    risk < 0.75 ? 5 :
    2;
  return { preMin, nag, repeatEveryMin };
}

// --- Routes ---
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Set/replace schedule for a device (admin endpoint simple)
app.put("/api/schedule/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const times = req.body?.times;

    if (!Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ error: "Body must include { times: [{hour,minute}, ...] }" });
    }
    if (times.length > 3) {
      return res.status(400).json({ error: "Max 3 schedules supported (times.length <= 3)" });
    }

    // ensure device exists
    await run(`INSERT OR IGNORE INTO devices(device_id, tz) VALUES (?, ?)`, [deviceId, TZ_DEFAULT]);

    // replace schedules
    await run(`DELETE FROM schedules WHERE device_id=?`, [deviceId]);

    for (let i = 0; i < times.length; i++) {
      const hour = Number(times[i].hour);
      const minute = Number(times[i].minute);
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return res.status(400).json({ error: `Invalid time at index ${i}` });
      }
      await run(
        `INSERT INTO schedules(device_id, slot, hour, minute) VALUES (?, ?, ?, ?)`,
        [deviceId, i, hour, minute]
      );
    }

    res.json({ ok: true, deviceId, timesCount: times.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Get schedule for firmware (includes AI policy fields)
app.get("/api/schedule/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;

    // device tz
    const dev = await get(`SELECT device_id, tz FROM devices WHERE device_id=?`, [deviceId]);
    const tz = dev?.tz || TZ_DEFAULT;

    const baseTimes = await all(
      `SELECT slot, hour, minute FROM schedules WHERE device_id=? ORDER BY slot ASC`,
      [deviceId]
    );

    const times = [];
    for (const row of baseTimes) {
      const { risk } = await computeRisk({ deviceId, tz, hour: row.hour, minute: row.minute });
      const policy = policyFromRisk(risk);

      times.push({
        hour: row.hour,
        minute: row.minute,
        preMin: policy.preMin,
        nag: policy.nag,
        repeatEveryMin: policy.repeatEveryMin
      });
    }

    res.json({ deviceId, tz, times });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Receive "taken" confirmation (from ESP)
app.post("/api/taken", async (req, res) => {
  try {
    const deviceId = req.body?.deviceId;
    let ts = req.body?.timestamp;

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ error: "deviceId required" });
    }

    // allow missing timestamp -> use server time
    if (!ts || typeof ts !== "number") {
      ts = Math.floor(Date.now() / 1000);
    } else {
      ts = Math.floor(ts);
    }

    // ensure device exists
    await run(`INSERT OR IGNORE INTO devices(device_id, tz) VALUES (?, ?)`, [deviceId, TZ_DEFAULT]);

    await run(
      `INSERT INTO taken_events(device_id, ts, created_at) VALUES (?, ?, ?)`,
      [deviceId, ts, Math.floor(Date.now() / 1000)]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Debug: view recent taken history
app.get("/api/history/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const rows = await all(
      `SELECT ts FROM taken_events WHERE device_id=? ORDER BY ts DESC LIMIT 50`,
      [deviceId]
    );
    res.json({ deviceId, last: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
    console.log(`DB: ${DB_PATH}`);
  });
}).catch(err => {
  console.error("DB init failed:", err);
  process.exit(1);
});
