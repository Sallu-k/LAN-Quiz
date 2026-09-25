'use strict';
// Simulates 10 teams + a host against a real server on a random port. No dependencies.
// Run: npm test   (takes ~15 seconds because it waits for real timers to expire)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp, validateBank } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanquiz-'));
const qFile = path.join(tmp, 'questions.json');

const mk = (id, answer) => ({ type: 'mcq', text: `Question ${id}`, options: ['w', 'x', 'y', 'z'], answer });
const goodBank = {
  rounds: [
    { name: 'R1', timerSeconds: 4, questions: [mk(1, 'A'), mk(2, 'B'), mk(3, 'C'), mk(4, 'D'), { type: 'text', text: 'Q5', answer: ['Paris', 'paris france'] }, { type: 'text', text: 'Q6', answer: null }] },
    { name: 'R2', timerSeconds: 3, questions: [mk(1, 'A'), mk(2, 'B'), mk(3, 'C'), mk(4, 'D'), mk(5, 'A'), mk(6, 'B')] },
  ],
  specials: [
    { text: 'Special one', type: 'mcq', options: ['a', 'b'], answer: 'B', timerSeconds: 3 },
    { text: 'Special two', type: 'text', answer: ['ok'], timerSeconds: 3 },
  ],
};
fs.writeFileSync(qFile, JSON.stringify(goodBank));

const teams = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);
let app; let base;

async function boot() {
  app = createApp({ questionsFile: qFile, dataDir: path.join(tmp, 'data'), port: 0, quiet: true, config: {
    graceMs: 500, questionsPerRound: 6, eventName: 'Test Night',
    teams: teams.map((id) => (id === 'T3' ? { id, name: 'Byte Busters' } : id)),
  } });
  base = `http://127.0.0.1:${await app.start()}`;
}

async function api(method, url, body, team) {
  const headers = { 'Content-Type': 'application/json' };
  if (team) { headers['x-team'] = team.id; headers['x-token'] = team.token; }
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}
const host = (action, body = {}) => api('POST', `/api/host/${action}`, body);
const hostState = async () => (await api('GET', '/api/host/state')).json;
const hostQuestions = async () => (await api('GET', '/api/host/questions')).json;
const card = (hs, id) => hs.teams.find((t) => t.id === id);

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${e.stack}`); await app.stop().catch(() => {}); process.exit(1); }
}

// answers for round 1: team k gets the first k of the four mcq right, rest wrong
function r1Answers(k, runId) {
  const right = { r0q0: 'A', r0q1: 'B', r0q2: 'C', r0q3: 'D' };
  const answers = {};
  Object.keys(right).forEach((qid, i) => { answers[qid] = i < k ? right[qid] : 'A' === right[qid] ? 'B' : 'A'; });
  return { runId, answers };
}

(async () => {
  await boot();
  const T = {};

  console.log('Login & identity');
  await step('all 10 teams can log in and get tokens', async () => {
    for (const id of teams) {
      const r = await api('POST', '/api/login', { teamId: id });
      assert.strictEqual(r.status, 200, r.text);
      T[id] = { id, token: r.json.token };
    }
  });
  await step('same team from a second device (no token) is rejected', async () => {
    const r = await api('POST', '/api/login', { teamId: 'T1' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'in-use');
  });
  await step('refresh with the saved token is accepted; "t1" and "1" normalise', async () => {
    for (const v of ['T1', 't1', '1']) {
      const r = await api('POST', '/api/login', { teamId: v, token: T.T1.token });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.teamId, 'T1');
    }
  });
  await step('event name is public; team names reach the phone and the dashboard', async () => {
    assert.deepStrictEqual((await api('GET', '/api/info')).json, { eventName: 'Test Night' });
    const r = await api('POST', '/api/login', { teamId: 'T3', token: T.T3.token });
    assert.strictEqual(r.json.teamName, 'Byte Busters');
    assert.strictEqual((await api('GET', '/api/team/state', undefined, T.T3)).json.teamName, 'Byte Busters');
    const hs = await hostState();
    assert.strictEqual(hs.eventName, 'Test Night');
    assert.strictEqual(card(hs, 'T3').name, 'Byte Busters');
    assert.strictEqual(card(hs, 'T4').name, 'T4', 'plain IDs double as names');
  });
  await step('the questions-per-round warning only applies when questionsPerRound is set', async () => {
    const short = { rounds: [{ name: 'Tiny', questions: [mk(1, 'A')] }], specials: goodBank.specials };
    assert.deepStrictEqual(validateBank(short, { defaultRoundSeconds: 30, defaultSpecialSeconds: 15 }).warnings, []);
    assert.ok(validateBank(short, { defaultRoundSeconds: 30, defaultSpecialSeconds: 15, questionsPerRound: 6 }).warnings.length === 1);
  });
  await step('unknown team -> 404, missing/wrong token -> 401', async () => {
    assert.strictEqual((await api('POST', '/api/login', { teamId: 'T99' })).status, 404);
    assert.strictEqual((await api('GET', '/api/team/state')).status, 401);
    assert.strictEqual((await api('GET', '/api/team/state', undefined, { id: 'T1', token: 'nope' })).status, 401);
  });

  console.log('Round 1: 10 simultaneous submissions');
  let runId;
  await step('no questions are visible before the host starts the round', async () => {
    const r = await api('GET', '/api/team/state', undefined, T.T1);
    assert.strictEqual(r.json.round, null);
  });
  await step('host starts round 1; team payload contains no correct answers', async () => {
    assert.strictEqual((await host('start-round', { roundIndex: 0 })).status, 200);
    const r = await api('GET', '/api/team/state', undefined, T.T1);
    runId = r.json.round.runId;
    assert.strictEqual(r.json.round.questions.length, 6);
    assert.ok(!/"answer"\s*:/.test(r.text), 'team state leaked an "answer" field');
    assert.strictEqual(r.json.round.phase, 'running');
  });
  await step('starting another round while one is running is refused', async () => {
    assert.strictEqual((await host('start-round', { roundIndex: 1 })).status, 409);
  });
  await step('all 10 teams submit in the same instant -> all recorded, correct scores', async () => {
    for (const id of teams.slice(1)) await api('GET', '/api/team/state', undefined, T[id]);
    const results = await Promise.all(teams.map((id, i) =>
      api('POST', '/api/team/submit', { ...r1Answers(Math.min(i, 4), runId), answers: { ...r1Answers(Math.min(i, 4), runId).answers, r0q4: 'PARIS!' } }, T[id])));
    results.forEach((r) => { assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.already, false); });
    const hs = await hostState();
    teams.forEach((id, i) => {
      const c = card(hs, id);
      assert.strictEqual(c.status, 'submitted', `${id} status`);
      // k mcq right (k=min(i,4)) + short text "PARIS!" (normalises to paris) = k+1; Q6 has no answer (manual)
      assert.strictEqual(c.submission.score, Math.min(i, 4) + 1, `${id} score`);
      assert.strictEqual(c.submission.total, 6);
      assert.strictEqual(c.submission.items[5].correct, null, 'manual question left unmarked');
    });
    const lines = fs.readFileSync(path.join(tmp, 'data', 'submissions.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((e) => e.type === 'round-submission');
    assert.strictEqual(lines.length, 10);
    assert.strictEqual(new Set(lines.map((l) => l.teamId)).size, 10);
  });
  await step('resubmitting cannot change answers (idempotent)', async () => {
    const r = await api('POST', '/api/team/submit', { runId, answers: { r0q0: 'B', r0q1: 'A' } }, T.T5);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.already, true);
    const c = card(await hostState(), 'T5');
    assert.strictEqual(c.submission.score, 5);
  });
  await step('host can override a mark and the count follows', async () => {
    let o = await host('override-mark', { runId, teamId: 'T1', qid: 'r0q5', correct: true });
    assert.strictEqual(o.status, 200);
    assert.strictEqual(card(await hostState(), 'T1').submission.score, 2);
    await host('override-mark', { runId, teamId: 'T1', qid: 'r0q5', correct: null });
    assert.strictEqual(card(await hostState(), 'T1').submission.score, 1);
  });
  await step('lock-now ends the round early and finalises it after the grace period', async () => {
    assert.strictEqual((await host('lock-now')).status, 200);
    await sleep(800);
    const hs = await hostState();
    assert.strictEqual(hs.round.phase, 'locked');
    assert.strictEqual((await host('lock-now')).status, 409);
  });

  console.log('Round 2: timer expiry, drafts, grace, lockout');
  let t0; let endsAt;
  await step('start round 2 with a 3s timer', async () => {
    assert.strictEqual((await host('start-round', { roundIndex: 1 })).status, 200);
    const s = await api('GET', '/api/team/state', undefined, T.T1);
    runId = s.json.round.runId; endsAt = s.json.round.endsAt; t0 = Date.now();
    assert.strictEqual(s.json.round.durationMs, 3000);
    assert.strictEqual(card(await hostState(), 'T1').status, 'answering');
    assert.strictEqual(card(await hostState(), 'T3').status, 'not started');
  });
  await step('drafts are stored for a phone that then goes silent', async () => {
    await api('GET', '/api/team/state', undefined, T.T2);
    await api('PUT', '/api/team/draft', { runId, answers: { r1q0: 'A', r1q1: 'B', r1q2: 'C' } }, T.T1);
    const r = await api('GET', '/api/team/state', undefined, T.T1);
    assert.deepStrictEqual(r.json.draft, { r1q0: 'A', r1q1: 'B', r1q2: 'C' });
  });
  await step('a stale tab from the previous round cannot submit', async () => {
    const r = await api('POST', '/api/team/submit', { runId: runId - 1, answers: {} }, T.T4);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'stale-run');
  });
  await step('auto-submit that lands just after the timer (inside the grace window) is accepted', async () => {
    await api('GET', '/api/team/state', undefined, T.T5);
    await sleep(Math.max(0, endsAt + 150 - Date.now()));
    const r = await api('POST', '/api/team/submit', { runId, auto: true, answers: { r1q0: 'A', r1q1: 'B' } }, T.T5);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.already, false);
    assert.strictEqual(r.json.submission.elapsedMs, 3000, 'elapsed capped at the round length');
  });
  await step('after the grace window: drafts auto-lock, silent-but-seen teams score 0, unseen teams stay "not started"', async () => {
    await sleep(Math.max(0, endsAt + 700 - Date.now()));
    const hs = await hostState();
    assert.strictEqual(hs.round.phase, 'locked');
    assert.strictEqual(card(hs, 'T1').status, 'auto-locked');
    assert.strictEqual(card(hs, 'T1').submission.score, 3, 'draft answers counted');
    assert.strictEqual(card(hs, 'T2').status, 'auto-locked');
    assert.strictEqual(card(hs, 'T2').submission.score, 0);
    assert.strictEqual(card(hs, 'T5').status, 'submitted');
    assert.strictEqual(card(hs, 'T5').submission.score, 2);
    assert.strictEqual(card(hs, 'T3').status, 'not started');
  });
  await step('a genuinely late submit is rejected; a locked team cannot overwrite', async () => {
    const late = await api('POST', '/api/team/submit', { runId, answers: { r1q0: 'A' } }, T.T3);
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.json.code, 'closed');
    const again = await api('POST', '/api/team/submit', { runId, answers: { r1q0: 'A', r1q1: 'B', r1q2: 'C', r1q3: 'D', r1q4: 'A', r1q5: 'B' } }, T.T2);
    assert.strictEqual(again.json.already, true);
    assert.strictEqual(card(await hostState(), 'T2').submission.score, 0);
  });
  await step('drafts are ignored once the round is locked', async () => {
    const r = await api('PUT', '/api/team/draft', { runId, answers: { r1q0: 'A' } }, T.T3);
    assert.strictEqual(r.json.ignored, true);
  });

  console.log('Special block');
  await step('host pushes a special to one team; only that team sees it, without the answer', async () => {
    assert.strictEqual((await host('push-special', { teamId: 'T1', specialId: 's0' })).status, 200);
    const mine = await api('GET', '/api/team/state', undefined, T.T1);
    assert.strictEqual(mine.json.special.question.text, 'Special one');
    assert.ok(!/"answer"\s*:/.test(JSON.stringify(mine.json.special)));
    assert.strictEqual((await api('GET', '/api/team/state', undefined, T.T2)).json.special, null);
    assert.strictEqual((await host('push-special', { teamId: 'T1', specialId: 's1' })).status, 409, 'one open special per team');
  });
  await step('the team answers, the dashboard shows it marked', async () => {
    const id = (await api('GET', '/api/team/state', undefined, T.T1)).json.special.id;
    const r = await api('POST', '/api/team/special-answer', { specialId: id, answer: 'b' }, T.T1);
    assert.strictEqual(r.status, 200);
    const s = (await hostState()).specials.find((x) => x.id === id);
    assert.strictEqual(s.correct, true);
    assert.strictEqual((await api('GET', '/api/team/state', undefined, T.T1)).json.special, null);
  });
  await step('an unanswered special times out and cannot be answered late', async () => {
    await host('push-special', { teamId: 'T2', specialId: 's1' });
    const sp = (await api('GET', '/api/team/state', undefined, T.T2)).json.special;
    await sleep(3800);
    const r = await api('POST', '/api/team/special-answer', { specialId: sp.id, answer: 'ok' }, T.T2);
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await hostState()).specials.find((x) => x.id === sp.id).status, 'timeout');
  });
  await step('the host can cancel a special pushed to the wrong team', async () => {
    await host('push-special', { teamId: 'T9', specialId: 's0' });
    const sp = (await hostState()).specials.find((x) => x.teamId === 'T9');
    assert.strictEqual((await host('cancel-special', { id: sp.id })).status, 200);
    assert.strictEqual((await api('GET', '/api/team/state', undefined, T.T9)).json.special, null);
  });

  console.log('Leaderboard');
  let round2RunId;
  const lbRow = (hs, id) => hs.leaderboard.rows.find((r) => r.id === id);
  await step('totals add up across both locked rounds plus correct specials', async () => {
    const hs = await hostState();
    round2RunId = hs.round.runId;
    assert.deepStrictEqual(hs.leaderboard.rounds.map((r) => r.name), ['R1', 'R2']);
    // R1: Ti scored min(i-1,4)+1; R2: T1 3 (draft), T2 0, T5 2; T1 also got special s0 right
    assert.deepStrictEqual(lbRow(hs, 'T1'), { ...lbRow(hs, 'T1'), total: 5, specials: 1 });
    assert.strictEqual(lbRow(hs, 'T2').total, 2);
    assert.strictEqual(lbRow(hs, 'T3').total, 3);
    assert.strictEqual(lbRow(hs, 'T3').name, 'Byte Busters');
    assert.ok(!(round2RunId in lbRow(hs, 'T3').rounds), 'a team that sat out a round has no score for it');
    assert.strictEqual(hs.leaderboard.rows[0].id, 'T5');
    assert.strictEqual(hs.leaderboard.rows[0].total, 7);
    assert.strictEqual(hs.leaderboard.rows[0].rank, 1);
  });
  await step('a hand-correction after locking updates the total once (no double counting)', async () => {
    await host('override-mark', { runId: round2RunId, teamId: 'T2', qid: 'r1q0', correct: true });
    await host('override-mark', { runId: round2RunId, teamId: 'T2', qid: 'r1q0', correct: true });
    assert.strictEqual(lbRow(await hostState(), 'T2').total, 3);
    await host('override-mark', { runId: round2RunId, teamId: 'T2', qid: 'r1q0', correct: null });
    assert.strictEqual(lbRow(await hostState(), 'T2').total, 2);
  });
  await step('the CSV export has a header and one row per team, ranked', async () => {
    const r = await api('GET', '/api/host/results.csv');
    assert.strictEqual(r.status, 200);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.strictEqual(lines.length, 11);
    assert.ok(/^Rank,Team ID,Team name,R1 \(run \d+\),R2 \(run \d+\),Specials,Total,Total time \(s\)$/.test(lines[0]), lines[0]);
    assert.ok(lines[1].startsWith('1,T5,T5,5,2,0,7,'), lines[1]);
    assert.ok(lines.some((l) => l.includes(',T3,Byte Busters,3,,0,3,')));
  });

  console.log('Question file reload');
  await step('a broken questions.json is rejected with readable errors; the old bank stays live', async () => {
    const bad = JSON.parse(JSON.stringify(goodBank));
    bad.rounds[0].questions[0].answer = 'Q';
    bad.rounds[1].questions[1].type = 'essay';
    fs.writeFileSync(qFile, JSON.stringify(bad));
    const r = await host('reload-questions');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.error.length, 2);
    assert.ok(/letter from A to D/.test(r.json.error[0]) && /Round 1/.test(r.json.error[0]));
    const hs = await hostState();
    assert.ok(hs.bank.error);
    assert.strictEqual(hs.bank.rounds.length, 2);
  });
  await step('a fixed file reloads and clears the error', async () => {
    const edited = JSON.parse(JSON.stringify(goodBank));
    edited.rounds.push({ name: 'R3', timerSeconds: 10, questions: [mk(1, 'A')] });
    fs.writeFileSync(qFile, JSON.stringify(edited));
    await host('reload-questions');
    const hs = await hostState();
    assert.strictEqual(hs.bank.error, null);
    assert.strictEqual(hs.bank.rounds.length, 3);
    assert.ok(hs.bank.warnings.some((w) => /R3.*1 questions/.test(w)));
  });
  await step('reload is refused while a round is running', async () => {
    await host('start-round', { roundIndex: 2 });
    assert.strictEqual((await host('reload-questions')).status, 409);
    await host('lock-now');
    await sleep(800);
  });

  console.log('Admin editor (GET/save questions)');
  let doc;
  await step('GET /api/host/questions returns an editable doc matching the live bank', async () => {
    doc = await hostQuestions();
    assert.strictEqual(doc.error, null);
    assert.strictEqual(doc.doc.rounds.length, 3);
    assert.deepStrictEqual(doc.doc.rounds[0].questions[0], { type: 'mcq', text: 'Question 1', options: ['w', 'x', 'y', 'z'], answer: 'A' });
    assert.strictEqual(doc.doc.specials[0].timerSeconds, 3);
  });
  await step('editing that doc and saving it updates the live bank and the file on disk', async () => {
    doc.doc.rounds.push({ name: 'R4', timerSeconds: 12, questions: [mk(1, 'C')] });
    doc.doc.specials[0].text = 'Special one (edited)';
    const r = await host('save-questions', { doc: doc.doc });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.error, null);
    const hs = await hostState();
    assert.strictEqual(hs.bank.rounds.length, 4);
    assert.strictEqual(hs.bank.rounds[3].name, 'R4');
    const onDisk = JSON.parse(fs.readFileSync(qFile, 'utf8'));
    assert.strictEqual(onDisk.rounds.length, 4);
    assert.strictEqual(onDisk.specials[0].text, 'Special one (edited)');
  });
  await step('saving an invalid doc is rejected with readable errors and leaves the file untouched', async () => {
    const before = fs.readFileSync(qFile, 'utf8');
    const bad = JSON.parse(JSON.stringify(doc.doc));
    bad.rounds[0].questions[0].options = ['only one'];
    const r = await host('save-questions', { doc: bad });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.error && r.json.error.length >= 1);
    assert.ok(/2 to 8/.test(r.json.error[0]));
    assert.strictEqual(fs.readFileSync(qFile, 'utf8'), before, 'file on disk must be unchanged after a rejected save');
    assert.strictEqual((await hostState()).bank.rounds.length, 4, 'live bank must be unchanged after a rejected save');
  });
  await step('save-questions is refused while a round is running', async () => {
    await host('start-round', { roundIndex: 0 });
    const r = await host('save-questions', { doc: doc.doc });
    assert.strictEqual(r.status, 409);
    await host('lock-now');
    await sleep(800);
  });
  await step('hostState never leaks an answer, for the round grid or an open special', async () => {
    await host('start-round', { roundIndex: 0 });
    await host('push-special', { teamId: 'T1', specialId: doc.doc.specials[0].id || 's0' });
    const hs = await hostState();
    assert.strictEqual(hs.round.questions.length, 6, 'round.questions is populated for the projector view');
    assert.ok(!/"answer"\s*:/.test(JSON.stringify(hs.round.questions)));
    const openSpecial = hs.specials.find((s) => s.status === 'open');
    assert.ok(openSpecial && openSpecial.question && openSpecial.question.text);
    assert.ok(!/"answer"\s*:/.test(JSON.stringify(openSpecial.question)));
    await host('lock-now');
    await sleep(800);
  });

  console.log('Restart');
  await step('a server restart keeps logins, submissions and specials', async () => {
    const before = await hostState();
    await app.stop();
    await boot();
    const r = await api('POST', '/api/login', { teamId: 'T1', token: T.T1.token });
    assert.strictEqual(r.status, 200, 'saved token still valid after restart');
    assert.strictEqual((await api('POST', '/api/login', { teamId: 'T1' })).status, 409, 'other device still blocked');
    const after = await hostState();
    assert.strictEqual(after.round.runId, before.round.runId);
    assert.strictEqual(after.specials.length, before.specials.length);
    assert.deepStrictEqual(after.leaderboard, before.leaderboard, 'leaderboard survives a restart');
  });
  await step('the host can drop one round from the leaderboard, or reset it', async () => {
    assert.strictEqual((await host('remove-history', { runId: round2RunId })).status, 200);
    let hs = await hostState();
    assert.ok(!hs.leaderboard.rounds.some((r) => r.runId === round2RunId));
    assert.strictEqual(lbRow(hs, 'T5').total, 5);
    assert.strictEqual((await host('remove-history', { runId: round2RunId })).status, 404);
    assert.strictEqual((await host('reset-leaderboard')).status, 200);
    hs = await hostState();
    assert.strictEqual(hs.leaderboard.rounds.length, 0);
    assert.ok(hs.leaderboard.rows.every((r) => r.total === 0 && r.specials === 0), 'old specials no longer count');
    assert.strictEqual(hs.leaderboard.rows.length, 10);
  });
  await step('host can release a team so a replacement phone can log in', async () => {
    assert.strictEqual((await host('release-team', { teamId: 'T1' })).status, 200);
    const r = await api('POST', '/api/login', { teamId: 'T1' });
    assert.strictEqual(r.status, 200);
  });

  await app.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
})();
