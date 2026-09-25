'use strict';
/*
 * LAN Quiz — local, offline rapid-fire answer system for quiz events.
 * Zero dependencies: Node's built-in http/fs only. Run with `npm start`.
 *
 * Node is single-threaded, so requests are handled strictly one at a time:
 * ten teams submitting in the same second cannot interleave or overwrite each other.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

// ---------------------------------------------------------------------------
// Question bank parsing / validation (plain-English errors for a non-programmer)
// ---------------------------------------------------------------------------
class BankError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.errors = errors;
  }
}

function parseQuestion(raw, id, where, errors) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where}: must be an object like { "type": ..., "text": ..., "answer": ... }`);
    return null;
  }
  const q = { id };
  q.text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!q.text) errors.push(`${where}: "text" is missing or empty`);

  if (raw.type !== 'mcq' && raw.type !== 'text') {
    errors.push(`${where}: "type" must be "mcq" or "text" (got ${JSON.stringify(raw.type)})`);
    return null;
  }
  q.type = raw.type;

  if (q.type === 'mcq') {
    const opts = raw.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 8 ||
        opts.some((o) => typeof o !== 'string' || !o.trim())) {
      errors.push(`${where}: "options" must be a list of 2 to 8 non-empty texts`);
      return null;
    }
    q.options = opts.map((o) => o.trim());
    if (raw.answer === undefined || raw.answer === null) {
      q.answer = null; // host marks manually
    } else {
      const letter = String(raw.answer).trim().toUpperCase();
      const valid = 'ABCDEFGH'.slice(0, q.options.length);
      if (letter.length !== 1 || !valid.includes(letter)) {
        errors.push(`${where}: "answer" must be a letter from A to ${valid[valid.length - 1]} (got ${JSON.stringify(raw.answer)})`);
        return null;
      }
      q.answer = letter;
    }
  } else {
    const a = raw.answer;
    if (a === undefined || a === null) {
      q.answer = null;
    } else if (typeof a === 'string' && a.trim()) {
      q.answer = [a.trim()];
    } else if (Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.trim())) {
      q.answer = a.map((x) => x.trim());
    } else {
      errors.push(`${where}: "answer" must be a text, a list of accepted texts, or null for manual marking`);
      return null;
    }
  }
  return q;
}

function parseSeconds(raw, fallback, where, errors) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !(raw >= 3 && raw <= 3600)) {
    errors.push(`${where}: "timerSeconds" must be a number between 3 and 3600`);
    return fallback;
  }
  return raw;
}

function loadBank(file, config) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BankError([`Cannot read ${path.basename(file)}: ${e.message}`]);
  }
  return validateBank(json, config);
}

// Pure validation of an already-parsed document (used at startup/reload, and
// to check an edit made in the admin UI before it's written to disk).
function validateBank(json, config) {
  if (!json || typeof json !== 'object') throw new BankError(['The question file must be a single { ... } object']);
  const errors = [];
  const warnings = [];
  const bank = { rounds: [], specials: [] };

  if (!Array.isArray(json.rounds) || json.rounds.length === 0) {
    errors.push('"rounds" must be a list with at least one round');
  } else {
    json.rounds.forEach((r, ri) => {
      const name = r && typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Round ${ri + 1}`;
      const where = name === `Round ${ri + 1}` ? name : `Round ${ri + 1} (${name})`;
      if (!r || !Array.isArray(r.questions) || r.questions.length === 0) {
        errors.push(`${where}: "questions" must be a list with at least one question`);
        return;
      }
      const seconds = parseSeconds(r.timerSeconds, config.defaultRoundSeconds, where, errors);
      const questions = [];
      r.questions.forEach((rawQ, qi) => {
        const q = parseQuestion(rawQ, `r${ri}q${qi}`, `${where}, question ${qi + 1}`, errors);
        if (q) questions.push(q);
      });
      const expected = config.questionsPerRound;
      if (expected && questions.length !== expected) warnings.push(`${where} has ${questions.length} questions (config.json expects ${expected})`);
      bank.rounds.push({ index: ri, name, seconds, questions });
    });
  }

  if (json.specials !== undefined) {
    if (!Array.isArray(json.specials)) {
      errors.push('"specials" must be a list');
    } else {
      json.specials.forEach((s, si) => {
        const where = `Special ${si + 1}`;
        const q = parseQuestion(s, `s${si}`, where, errors);
        if (!q) return;
        q.seconds = parseSeconds(s.timerSeconds, config.defaultSpecialSeconds, where, errors);
        bank.specials.push(q);
      });
    }
  }
  if (bank.specials.length === 0 && errors.length === 0) warnings.push('No special questions defined');

  if (errors.length) throw new BankError(errors);
  return { bank, warnings };
}

// The reverse of validateBank: turns the normalized, in-memory bank back into
// a plain { rounds, specials } document — the same shape as questions.json —
// for the admin editor to load and (once the host is done editing) resubmit.
function bankToDoc(bank) {
  const questionDoc = (q) => ({
    type: q.type, text: q.text,
    ...(q.type === 'mcq' ? { options: q.options } : {}),
    answer: q.answer,
  });
  return {
    rounds: bank.rounds.map((r) => ({ name: r.name, timerSeconds: r.seconds, questions: r.questions.map(questionDoc) })),
    specials: bank.specials.map((s) => ({ ...questionDoc(s), timerSeconds: s.seconds })),
  };
}

// ---------------------------------------------------------------------------
// Answer checking
// ---------------------------------------------------------------------------
function normText(s) {
  return String(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// true / false, or null when the question has no auto-check answer
function autoMark(q, given) {
  if (q.answer === null) return null;
  if (!given) return false;
  if (q.type === 'mcq') return given === q.answer;
  const g = normText(given);
  return g !== '' && q.answer.some((a) => normText(a) === g);
}

const publicQ = (q) => ({
  id: q.id, type: q.type, text: q.text, ...(q.type === 'mcq' ? { options: q.options } : {}),
});

function expectedLabel(q) {
  if (q.answer === null) return null;
  if (q.type === 'mcq') return `${q.answer} — ${q.options[q.answer.charCodeAt(0) - 65]}`;
  return q.answer.join(' / ');
}

function givenLabel(q, given) {
  if (!given) return '';
  if (q.type === 'mcq') return `${given} — ${q.options[given.charCodeAt(0) - 65] ?? ''}`;
  return given;
}

function cleanAnswers(questions, answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const q of questions) {
    let v = answers[q.id];
    if (typeof v !== 'string') continue;
    v = v.trim().slice(0, 200);
    if (q.type === 'mcq') {
      v = v.toUpperCase();
      if (v.length !== 1 || v.charCodeAt(0) - 65 >= q.options.length || v < 'A') continue;
    }
    if (v) out[q.id] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
function readConfig(file) {
  const defaults = {
    eventName: 'LAN Quiz',
    port: 8080,
    hostKey: '',
    teams: Array.from({ length: 10 }, (_, i) => `T${i + 1}`),
    defaultRoundSeconds: 30,
    defaultSpecialSeconds: 15,
    graceMs: 1500,
  };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  return { ...defaults, ...raw };
}

function createApp(opts = {}) {
  const config = { ...readConfig(opts.configFile || path.join(ROOT, 'config.json')), ...(opts.config || {}) };
  if (process.env.PORT !== undefined && opts.port === undefined) config.port = Number(process.env.PORT);
  if (opts.port !== undefined) config.port = opts.port;
  const questionsFile = opts.questionsFile || path.join(ROOT, 'questions.json');
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const stateFile = path.join(dataDir, 'state.json');
  const logFile = path.join(dataDir, 'submissions.jsonl');
  const quiet = !!opts.quiet;
  const say = (...a) => { if (!quiet) console.log(...a); };

  // ---- teams ----
  // Each entry is either "T1" or { "id": "T1", "name": "Byte Busters" }.
  const teamList = config.teams.map((t) => {
    const id = String(t && typeof t === 'object' ? t.id : t).trim();
    const name = t && typeof t === 'object' && typeof t.name === 'string' && t.name.trim() ? t.name.trim() : id;
    return { id, name };
  });
  const teamIds = teamList.map((t) => t.id);
  const teamNames = new Map(teamList.map((t) => [t.id, t.name]));
  const teamLookup = new Map(teamIds.map((t) => [t.toUpperCase(), t]));
  function normTeamId(input) {
    const s = String(input ?? '').trim().toUpperCase();
    if (teamLookup.has(s)) return teamLookup.get(s);
    if (/^\d+$/.test(s) && teamLookup.has(`T${Number(s)}`)) return teamLookup.get(`T${Number(s)}`);
    return null;
  }

  // ---- question bank ----
  let { bank, warnings: bankWarnings } = loadBank(questionsFile, config); // throws BankError at startup
  let bankError = null;

  // ---- state (persisted) ----
  fs.mkdirSync(dataDir, { recursive: true });
  const freshState = () => ({
    runCounter: 0,
    specialCounter: 0,
    teams: {},          // teamId -> { token, claimedAt }
    round: null,        // { runId, roundIndex, name, startedAt, endsAt, durationMs, finalisedAt, questions }
    seen: {},           // teamId -> true once the phone has fetched the running round
    drafts: {},         // teamId -> { answers, updatedAt }
    submissions: {},    // teamId -> { answers, receivedAt, elapsedMs, source, overrides }
    specials: [],       // pushed special questions (history)
    history: [],        // finished rounds for the leaderboard: { runId, name, finishedAt, results: { teamId: { score, total, elapsedMs } } }
    leaderboardSince: 0, // specials pushed before this (a leaderboard reset) don't count
  });
  let state = freshState();
  if (opts.fresh && fs.existsSync(stateFile)) {
    const archived = path.join(dataDir, `state.${Date.now()}.bak.json`);
    fs.renameSync(stateFile, archived);
    say(`Fresh start: previous state archived to ${path.relative(ROOT, archived)}`);
  }
  if (fs.existsSync(stateFile)) {
    try {
      state = { ...freshState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
      say('Restored previous event state from data/state.json');
    } catch (e) {
      const bad = path.join(dataDir, `state.${Date.now()}.corrupt.json`);
      fs.renameSync(stateFile, bad);
      console.error(`!! state.json was unreadable (${e.message}); moved to ${bad} and starting empty.`);
    }
  }

  const lastSeen = {}; // teamId -> ms (memory only)

  function atomicWrite(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    atomicWrite(stateFile, JSON.stringify(state));
  }
  let saveTimer = null;
  function saveSoon() { // coalesce frequent low-value writes (drafts)
    if (!saveTimer) saveTimer = setTimeout(save, 500);
  }
  function logEvent(type, payload) {
    try {
      fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), type, ...payload }) + '\n');
    } catch (e) {
      console.error('log write failed:', e.message);
    }
  }

  // ---- round helpers ----
  function phase(now) {
    const r = state.round;
    if (!r) return 'idle';
    if (r.finalisedAt) return 'locked';
    return now < r.endsAt ? 'running' : 'closing';
  }

  function makeSubmission(r, answers, receivedAt, source) {
    return {
      answers: cleanAnswers(r.questions, answers),
      receivedAt,
      elapsedMs: Math.max(0, Math.min(receivedAt, r.endsAt) - r.startedAt),
      source,
      overrides: {},
    };
  }

  function finaliseRound(now) {
    const r = state.round;
    r.finalisedAt = now;
    for (const id of teamIds) {
      if (state.submissions[id] || !state.seen[id]) continue; // teams that never opened the round stay "not started"
      const draft = state.drafts[id];
      const sub = makeSubmission(r, draft ? draft.answers : {}, r.endsAt, 'auto-locked');
      state.submissions[id] = sub;
      logEvent('round-submission', { runId: r.runId, teamId: id, source: sub.source, answers: sub.answers });
    }
    recordHistory();
    save();
  }

  // ---- leaderboard ----
  // Copy the locked round's scores into history (replacing any earlier copy of the same run,
  // so hand-corrections made after locking update the totals instead of double-counting).
  function recordHistory() {
    const r = state.round;
    if (!r || !r.finalisedAt) return;
    const results = {};
    for (const [teamId, sub] of Object.entries(state.submissions)) {
      results[teamId] = {
        score: r.questions.filter((q) => effectiveMark(q, sub) === true).length,
        total: r.questions.length,
        elapsedMs: sub.elapsedMs,
      };
    }
    const entry = { runId: r.runId, name: r.name, finishedAt: r.finalisedAt, results };
    const i = state.history.findIndex((h) => h.runId === r.runId);
    if (i >= 0) state.history[i] = entry; else state.history.push(entry);
  }

  function leaderboard() {
    const rows = teamIds.map((id) => ({ id, name: teamNames.get(id), rounds: {}, specials: 0, total: 0, totalTimeMs: 0 }));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const h of state.history) {
      for (const [teamId, res] of Object.entries(h.results)) {
        const row = byId.get(teamId);
        if (!row) continue; // team removed from config.json since
        row.rounds[h.runId] = res.score;
        row.total += res.score;
        row.totalTimeMs += res.elapsedMs;
      }
    }
    for (const s of state.specials) {
      const row = byId.get(s.teamId);
      if (!row || s.status !== 'answered' || s.pushedAt < state.leaderboardSince) continue;
      if (autoMark(s.question, s.answer) === true) { row.specials += 1; row.total += 1; }
    }
    rows.sort((a, b) => b.total - a.total || a.totalTimeMs - b.totalTimeMs);
    let rank = 0;
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      if (!prev || prev.total !== row.total || prev.totalTimeMs !== row.totalTimeMs) rank = i + 1;
      row.rank = rank;
    });
    return { rounds: state.history.map((h) => ({ runId: h.runId, name: h.name })), rows };
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function leaderboardCsv() {
    const lb = leaderboard();
    const header = ['Rank', 'Team ID', 'Team name', ...lb.rounds.map((r) => `${r.name} (run ${r.runId})`), 'Specials', 'Total', 'Total time (s)'];
    const lines = [header, ...lb.rows.map((row) => [
      row.rank, row.id, row.name,
      ...lb.rounds.map((r) => (row.rounds[r.runId] ?? '')),
      row.specials, row.total, (row.totalTimeMs / 1000).toFixed(1),
    ])];
    return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8 names
  }

  function tick() {
    const now = Date.now();
    let changed = false;
    const r = state.round;
    if (r && !r.finalisedAt && now >= r.endsAt + config.graceMs) {
      finaliseRound(now);
      changed = true;
    }
    for (const s of state.specials) {
      if (s.status === 'open' && now >= s.endsAt + config.graceMs) {
        s.status = 'timeout';
        logEvent('special-timeout', { id: s.id, teamId: s.teamId });
        changed = true;
      }
    }
    if (changed) save();
  }

  // ---- team-facing ----
  function authTeam(req) {
    const teamId = normTeamId(req.headers['x-team']);
    const token = req.headers['x-token'];
    if (!teamId || !state.teams[teamId] || !token || state.teams[teamId].token !== token) {
      fail(401, 'auth', 'Please log in again.');
    }
    lastSeen[teamId] = Date.now();
    return teamId;
  }

  function login(body) {
    const teamId = normTeamId(body.teamId);
    if (!teamId) fail(404, 'unknown-team', 'Unknown Team ID. Check with the organisers.');
    const existing = state.teams[teamId];
    if (existing && existing.token !== body.token) {
      fail(409, 'in-use', `${teamId} is already logged in on another device. Ask the host to release it.`);
    }
    if (!existing) {
      state.teams[teamId] = { token: crypto.randomBytes(12).toString('hex'), claimedAt: Date.now() };
      save();
    }
    lastSeen[teamId] = Date.now();
    return { teamId, teamName: teamNames.get(teamId), token: state.teams[teamId].token };
  }

  function teamState(teamId, now) {
    const r = state.round;
    const ph = phase(now);
    const out = { serverNow: now, team: teamId, teamName: teamNames.get(teamId), eventName: config.eventName, round: null, submission: null, draft: null, special: null };
    if (r) {
      if ((ph === 'running' || ph === 'closing') && !state.seen[teamId]) {
        state.seen[teamId] = true;
        save();
      }
      out.round = {
        runId: r.runId, name: r.name, phase: ph, startedAt: r.startedAt, endsAt: r.endsAt,
        durationMs: r.durationMs, questions: r.questions.map(publicQ),
      };
      const sub = state.submissions[teamId];
      if (sub) out.submission = { answers: sub.answers, elapsedMs: sub.elapsedMs, source: sub.source };
      const d = state.drafts[teamId];
      if (d) out.draft = d.answers;
    }
    for (let i = state.specials.length - 1; i >= 0; i--) {
      const s = state.specials[i];
      if (s.teamId === teamId && s.status === 'open') {
        out.special = {
          id: s.id, phase: now < s.endsAt ? 'running' : 'closing', endsAt: s.endsAt,
          durationMs: s.seconds * 1000, question: publicQ(s.question),
        };
        break;
      }
    }
    return out;
  }

  function putDraft(teamId, body, now) {
    const r = state.round;
    const ph = phase(now);
    if (!r || body.runId !== r.runId || ph === 'locked' || ph === 'idle') return { ok: true, ignored: true };
    if (state.submissions[teamId]) return { ok: true, ignored: true };
    state.drafts[teamId] = { answers: cleanAnswers(r.questions, body.answers), updatedAt: now };
    state.seen[teamId] = true;
    saveSoon();
    return { ok: true };
  }

  function submitRound(teamId, body, now) {
    const r = state.round;
    if (!r) fail(409, 'no-round', 'There is no round in progress.');
    if (body.runId !== r.runId) fail(409, 'stale-run', 'That round is over. Reload the page.');
    const existing = state.submissions[teamId];
    if (existing) return { ok: true, already: true, submission: { answers: existing.answers, elapsedMs: existing.elapsedMs, source: existing.source } };
    if (r.finalisedAt || now > r.endsAt + config.graceMs) fail(409, 'closed', 'Time is up — this round is closed.');
    const sub = makeSubmission(r, body.answers, now, body.auto ? 'auto' : 'manual');
    state.seen[teamId] = true;
    state.submissions[teamId] = sub;
    save();
    logEvent('round-submission', { runId: r.runId, teamId, source: sub.source, elapsedMs: sub.elapsedMs, answers: sub.answers });
    return { ok: true, already: false, submission: { answers: sub.answers, elapsedMs: sub.elapsedMs, source: sub.source } };
  }

  function answerSpecial(teamId, body, now) {
    const s = state.specials.find((x) => x.id === body.specialId && x.teamId === teamId);
    if (!s) fail(404, 'no-special', 'That question is no longer available.');
    if (s.status === 'answered') return { ok: true, already: true };
    if (s.status !== 'open' || now > s.endsAt + config.graceMs) fail(409, 'closed', 'Time is up for this question.');
    const cleaned = cleanAnswers([s.question], { [s.question.id]: body.answer });
    s.answer = cleaned[s.question.id] || '';
    s.answeredAt = now;
    s.status = 'answered';
    save();
    logEvent('special-answer', { id: s.id, teamId, answer: s.answer });
    return { ok: true, already: false };
  }

  // ---- host-facing ----
  function ownAddresses() {
    const set = new Set(['127.0.0.1', '::1']);
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) set.add(i.address);
    return set;
  }
  function lanUrls() {
    const urls = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${actualPort}`);
    }
    return urls;
  }
  function requireHost(req) {
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ownAddresses().has(addr)) return;
    if (config.hostKey && req.headers['x-host-key'] === config.hostKey) return;
    fail(401, 'host-auth', 'Host key required.');
  }

  function effectiveMark(q, sub) {
    const o = sub.overrides[q.id];
    return o !== undefined ? o : autoMark(q, sub.answers[q.id]);
  }

  function hostState(now) {
    const r = state.round;
    const ph = phase(now);
    const teams = teamIds.map((id) => {
      const sub = state.submissions[id] || null;
      let status = 'not started';
      if (sub) status = sub.source === 'auto-locked' ? 'auto-locked' : 'submitted';
      else if (r && state.seen[id] && ph !== 'locked') status = 'answering';
      const seenAgo = lastSeen[id] ? now - lastSeen[id] : null;
      const card = {
        id, name: teamNames.get(id), status, claimed: !!state.teams[id],
        connected: seenAgo !== null && seenAgo < 5000, seenAgoMs: seenAgo,
        submission: null,
      };
      if (sub && r) {
        const items = r.questions.map((q) => {
          const auto = autoMark(q, sub.answers[q.id]);
          const o = sub.overrides[q.id];
          return {
            qid: q.id, text: q.text, given: givenLabel(q, sub.answers[q.id]), expected: expectedLabel(q),
            auto, overridden: o !== undefined, correct: o !== undefined ? o : auto,
          };
        });
        card.submission = {
          items, score: items.filter((i) => i.correct === true).length, total: items.length,
          elapsedMs: sub.elapsedMs, source: sub.source,
        };
      }
      return card;
    });
    const active = teamIds.filter((id) => state.seen[id]);
    return {
      serverNow: now,
      eventName: config.eventName,
      round: r && {
        runId: r.runId, roundIndex: r.roundIndex, name: r.name, phase: ph,
        startedAt: r.startedAt, endsAt: r.endsAt, durationMs: r.durationMs, total: r.questions.length,
        questions: r.questions.map(publicQ), // answer-free — safe for the projector view too
      },
      allActiveSubmitted: ph === 'running' && active.length > 0 && active.every((id) => state.submissions[id]),
      teams,
      specials: state.specials.slice(-30).reverse().map((s) => ({
        id: s.id, teamId: s.teamId, text: s.question.text, question: publicQ(s.question), status: s.status,
        given: givenLabel(s.question, s.answer), expected: expectedLabel(s.question),
        correct: s.status === 'answered' ? autoMark(s.question, s.answer) : null,
        pushedAt: s.pushedAt, endsAt: s.endsAt,
      })),
      bank: {
        rounds: bank.rounds.map((x) => ({ index: x.index, name: x.name, seconds: x.seconds, count: x.questions.length })),
        specials: bank.specials.map((x) => ({ id: x.id, text: x.text, seconds: x.seconds, type: x.type })),
        error: bankError, warnings: bankWarnings,
      },
      leaderboard: leaderboard(),
      urls: lanUrls(),
    };
  }

  function hostAction(action, body, now) {
    const ph = phase(now);
    switch (action) {
      case 'start-round': {
        if (ph === 'running' || ph === 'closing') fail(409, 'busy', 'A round is still running. Press "Lock now" first.');
        const round = bank.rounds[Number(body.roundIndex)];
        if (!round) fail(400, 'bad-round', 'Unknown round.');
        state.runCounter += 1;
        state.round = {
          runId: state.runCounter, roundIndex: round.index, name: round.name, startedAt: now,
          endsAt: now + round.seconds * 1000, durationMs: round.seconds * 1000, finalisedAt: null,
          questions: JSON.parse(JSON.stringify(round.questions)),
        };
        state.seen = {};
        state.drafts = {};
        state.submissions = {};
        save();
        logEvent('round-start', { runId: state.runCounter, name: round.name });
        return { ok: true };
      }
      case 'lock-now': {
        if (ph !== 'running') fail(409, 'not-running', 'No round is running.');
        state.round.endsAt = now; // teams' phones auto-submit; server finalises after the grace period
        save();
        logEvent('round-lock-now', { runId: state.round.runId });
        return { ok: true };
      }
      case 'push-special': {
        const teamId = normTeamId(body.teamId);
        if (!teamId) fail(400, 'bad-team', 'Pick a team.');
        const q = bank.specials.find((s) => s.id === body.specialId);
        if (!q) fail(400, 'bad-special', 'Pick a special question.');
        if (state.specials.some((s) => s.teamId === teamId && s.status === 'open')) {
          fail(409, 'busy', `${teamId} already has a special question open.`);
        }
        state.specialCounter += 1;
        state.specials.push({
          id: `p${state.specialCounter}`, teamId, question: JSON.parse(JSON.stringify(q)), seconds: q.seconds,
          pushedAt: now, endsAt: now + q.seconds * 1000, status: 'open', answer: null,
        });
        save();
        logEvent('special-push', { teamId, question: q.id });
        return { ok: true, warning: state.teams[teamId] ? undefined : `${teamId} has not logged in yet.` };
      }
      case 'cancel-special': {
        const s = state.specials.find((x) => x.id === body.id);
        if (!s || s.status !== 'open') fail(409, 'not-open', 'That question is not open.');
        s.status = 'cancelled';
        save();
        return { ok: true };
      }
      case 'release-team': {
        const teamId = normTeamId(body.teamId);
        if (!teamId) fail(400, 'bad-team', 'Unknown team.');
        delete state.teams[teamId];
        delete lastSeen[teamId];
        save();
        logEvent('team-release', { teamId });
        return { ok: true };
      }
      case 'reload-questions': {
        if (ph === 'running' || ph === 'closing') fail(409, 'busy', 'Wait until the round is locked, then reload.');
        try {
          const res = loadBank(questionsFile, config);
          bank = res.bank; bankWarnings = res.warnings; bankError = null;
        } catch (e) {
          if (!(e instanceof BankError)) throw e;
          bankError = e.errors; // keep the previous, valid bank
        }
        return { ok: true, error: bankError };
      }
      case 'save-questions': {
        if (ph === 'running' || ph === 'closing') fail(409, 'busy', 'Wait until the round is locked, then save.');
        let res;
        try {
          res = validateBank(body.doc, config);
        } catch (e) {
          if (!(e instanceof BankError)) throw e;
          return { ok: true, error: e.errors }; // bad input, not a server error — old bank/file untouched
        }
        atomicWrite(questionsFile, JSON.stringify(body.doc, null, 2));
        bank = res.bank; bankWarnings = res.warnings; bankError = null;
        logEvent('save-questions', { rounds: bank.rounds.length, specials: bank.specials.length });
        return { ok: true, error: null, warnings: bankWarnings };
      }
      case 'override-mark': {
        const teamId = normTeamId(body.teamId);
        const sub = teamId && state.submissions[teamId];
        const r = state.round;
        if (!sub || !r || body.runId !== r.runId) fail(409, 'no-submission', 'Nothing to mark.');
        const q = r.questions.find((x) => x.id === body.qid);
        if (!q) fail(400, 'bad-question', 'Unknown question.');
        const value = body.correct === null ? undefined : !!body.correct;
        if (value === undefined || value === autoMark(q, sub.answers[q.id])) delete sub.overrides[q.id];
        else sub.overrides[q.id] = value;
        recordHistory(); // no-op until the round is locked
        save();
        logEvent('override-mark', { teamId, qid: q.id, correct: body.correct });
        return { ok: true };
      }
      case 'remove-history': {
        const i = state.history.findIndex((h) => h.runId === body.runId);
        if (i < 0) fail(404, 'no-history', 'That round is not on the leaderboard.');
        if (state.round && state.round.runId === body.runId && ph !== 'locked') fail(409, 'busy', 'That round is still running.');
        const [gone] = state.history.splice(i, 1);
        save();
        logEvent('leaderboard-remove', { runId: gone.runId, name: gone.name });
        return { ok: true };
      }
      case 'reset-leaderboard': {
        state.history = [];
        state.leaderboardSince = now;
        save();
        logEvent('leaderboard-reset', {});
        return { ok: true };
      }
      default:
        return fail(404, 'no-action', 'Unknown action.');
    }
  }

  // ---- HTTP plumbing ----
  const PAGES = { '/team': 'team.html', '/dashboard': 'dashboard.html', '/admin': 'admin.html', '/projector': 'projector.html' };
  // Small shared assets used by more than one page (themes, the theme picker) — same directory, same no-cache policy.
  const ASSETS = {
    '/themes.css': ['themes.css', 'text/css'],
    '/theme-picker.js': ['theme-picker.js', 'application/javascript'],
    '/event-name.js': ['event-name.js', 'application/javascript'],
  };

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new HttpError(413, 'too-big', 'Request too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size === 0) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'bad-json', 'Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();
    tick();

    if (req.method === 'GET') {
      if (p === '/') { res.writeHead(302, { Location: '/team' }); return res.end(); }
      if (PAGES[p]) {
        const html = fs.readFileSync(path.join(ROOT, 'public', PAGES[p]));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (ASSETS[p]) {
        const [file, type] = ASSETS[p];
        const body = fs.readFileSync(path.join(ROOT, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/ping') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
      if (p === '/api/info') return sendJson(res, 200, { eventName: config.eventName });
      if (p === '/api/host/results.csv') {
        requireHost(req);
        const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="quiz-results-${stamp}.csv"`,
        });
        return res.end(leaderboardCsv());
      }
      if (p === '/api/team/state') return sendJson(res, 200, teamState(authTeam(req), now));
      if (p === '/api/host/state') { requireHost(req); return sendJson(res, 200, hostState(now)); }
      if (p === '/api/host/questions') { requireHost(req); return sendJson(res, 200, { doc: bankToDoc(bank), error: bankError, warnings: bankWarnings }); }
      return fail(404, 'not-found', 'Not found');
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readBody(req);
      if (p === '/api/login') return sendJson(res, 200, login(body));
      if (p === '/api/team/draft') return sendJson(res, 200, putDraft(authTeam(req), body, now));
      if (p === '/api/team/submit') return sendJson(res, 200, submitRound(authTeam(req), body, now));
      if (p === '/api/team/special-answer') return sendJson(res, 200, answerSpecial(authTeam(req), body, now));
      if (p.startsWith('/api/host/')) {
        requireHost(req);
        return sendJson(res, 200, hostAction(p.slice('/api/host/'.length), body, now));
      }
      return fail(404, 'not-found', 'Not found');
    }
    return fail(405, 'method', 'Method not allowed');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      return sendJson(res, 500, { error: 'Server error', code: 'server' });
    });
  });
  server.keepAliveTimeout = 5000;

  let actualPort = config.port;
  const timer = setInterval(tick, 250);

  return {
    server, config, teamIds,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '0.0.0.0', () => {
          actualPort = server.address().port;
          resolve(actualPort);
        });
      });
    },
    urls: lanUrls,
    warnings: () => bankWarnings,
    stop() {
      clearInterval(timer);
      if (saveTimer) save();
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = { createApp, BankError, autoMark, normText, validateBank, bankToDoc };

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (require.main === module) {
  let app;
  try {
    app = createApp({ fresh: process.argv.includes('--fresh') });
  } catch (e) {
    if (e instanceof BankError) {
      console.error('\nquestions.json has problems — fix these and start again:\n');
      e.errors.forEach((m) => console.error('  - ' + m));
      console.error('');
    } else {
      console.error(e.message);
    }
    process.exit(1);
  }
  app.start().then((port) => {
    console.log(`\n=== ${app.config.eventName} — quiz server running ===\n`);
    console.log('Teams type this into their phone browser:');
    const urls = app.urls();
    if (urls.length === 0) console.log('  (no network address found — connect the laptop to the router wifi/cable!)');
    urls.forEach((u) => console.log(`  ${u}/team`));
    console.log(`\nHost dashboard (on this laptop):  http://localhost:${port}/dashboard`);
    console.log(`Teams configured: ${app.teamIds.join(', ')}`);
    app.warnings().forEach((w) => console.log(`Note: ${w}`));
    const key = app.config.hostKey;
    if (!key) console.log('Note: "hostKey" is empty, so the dashboard/admin/projector only work on this laptop.');
    else if (key === 'change-me') console.log('WARNING: "hostKey" is still "change-me" — set your own in config.json before the event.');
    console.log('\nPress Ctrl+C to stop. State is saved in data/ and survives a restart.\n');
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort is already in use. Is the server already running? (or change "port" in config.json)\n`);
    else console.error(e);
    process.exit(1);
  });
  const shutdown = () => app.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
