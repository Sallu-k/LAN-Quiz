# LAN Quiz — offline quiz system for events with slow or no internet

Run a live, timed quiz where every team answers on their own phone, **without the internet**. One laptop runs the quiz; phones connect to it over local wifi (a router or a hotspot). The host controls rounds from a dashboard, a projector screen shows the questions, and scores add up on a leaderboard you can download as a spreadsheet.

Built for a college on a hill where campus wifi and mobile data collapse when a hall full of students connects at once. Local wifi doesn't need the internet at all, so it stays fast no matter how bad the outside connection is.

- **No internet needed**, and nothing to install beyond [Node.js](https://nodejs.org) 18 or newer. No `npm install` step, no accounts, no cloud.
- **Phones just open a web page.** No app to install.
- **Hard to break:** answers are saved on the phone as teams type, everything is saved to disk after every change, and a crashed laptop picks up where it left off.
- **Fair:** one server clock for everyone, one phone per team, and correct answers are never sent to phones.

| Screen | Who uses it | Address |
|---|---|---|
| Team page | each team, on a phone | `http://<laptop-ip>:8080/team` |
| Host dashboard | the host, on the laptop | `http://localhost:8080/dashboard` |
| Projector | big screen / HDMI | `http://localhost:8080/projector` |
| Question admin | whoever writes the questions | `http://localhost:8080/admin` |

---

## 1. Quick start

1. Install [Node.js LTS](https://nodejs.org) on the laptop (one time, needs internet once).
2. Download this project (green **Code** button on GitHub → *Download ZIP*, then extract it), or `git clone` it.
3. Open a terminal in the project folder and run:

   ```bash
   npm start
   ```

   It prints something like:

   ```
   === LAN Quiz — quiz server running ===

   Teams type this into their phone browser:
     http://192.168.1.27:8080/team

   Host dashboard (on this laptop):  http://localhost:8080/dashboard
   ```

4. Teams open the `/team` address on their phones and type their Team ID (`T1`, `T2`, …; `t1` or just `1` also work).
5. The host opens `http://localhost:8080/dashboard` on the laptop.

If several addresses are listed (wifi + VPN, etc.), teams need the one on the **quiz wifi**, usually `192.168.x.x` or `10.x.x.x`.

Stop with `Ctrl+C`. Everything is saved in the `data/` folder, so if the laptop dies mid-event just run `npm start` again.

---

## 2. Before your event: set it up for your quiz

Edit **`config.json`** (any text editor, e.g. Notepad):

```json
{
  "eventName": "Tech Fest Quiz 2027",
  "port": 8080,
  "hostKey": "pick-your-own-password",
  "teams": [
    { "id": "T1", "name": "Byte Busters" },
    { "id": "T2", "name": "Null Pointers" },
    "T3", "T4", "T5"
  ],
  "defaultRoundSeconds": 30,
  "defaultSpecialSeconds": 15,
  "graceMs": 1500
}
```

| Key | Default | Meaning |
|---|---|---|
| `eventName` | `LAN Quiz` | Shown on phones, the projector and browser tabs. |
| `port` | `8080` | Port in the team URL. (`PORT=9000 npm start` overrides it for one run.) |
| `hostKey` | `change-me` | Password for the dashboard, admin and projector **when opened from another device**. On the laptop itself no key is needed. **Change it** before the event; the server warns you if you don't. |
| `teams` | `T1`…`T10` | Team IDs. Each one is either a plain ID (`"T3"`) or `{ "id": "T1", "name": "Byte Busters" }` to show a team name too. Add as many as you need. Teams log in with the **ID**. |
| `defaultRoundSeconds` | `30` | Timer for a round that doesn't set its own. |
| `defaultSpecialSeconds` | `15` | Timer for a special question that doesn't set its own. |
| `graceMs` | `1500` | How long after 0:00 the server still accepts a phone's automatic last-second submit (network delay allowance). Nobody can type after 0:00. |
| `questionsPerRound` | *(not set)* | Optional. If set (e.g. `6`), you get a reminder when a round has a different number of questions. |

Then write your questions: open `http://localhost:8080/admin` (see §5).

---

## 3. Network setup (the part that matters most)

The laptop and every phone must be on the **same local wifi**. It does **not** need internet.

### Pick a network

| Option | Good for | Notes |
|---|---|---|
| **A spare wifi router** (no internet cable needed) | Any size, best choice | Even a cheap home router handles 20–50 phones. Most reliable. |
| **Windows Mobile Hotspot** on the host laptop | Up to **8 teams** | Windows caps it at 8 devices. Settings → Network & internet → Mobile hotspot. Works even with no internet: if it refuses to turn on, connect the laptop to anything first, or use a router. |
| **A phone's hotspot** | Tiny quizzes only | Many phones cap at 5–10 devices and the host phone's battery drains fast. |
| **Campus wifi** | Only if the phones can see each other | Many campus networks block device-to-device traffic ("client isolation"), so phones can't reach the laptop. Test first. |

### Setting up a router
1. Power it on with **no internet cable** (that's fine). Give the wifi a simple name and password.
2. Connect the laptop to it (a cable is more reliable than wifi, but wifi works).
3. **Fix the laptop's address** so the team URL doesn't change between rehearsal and the event: in the router's admin page, add a *DHCP reservation* for the laptop.
4. **Turn off "AP isolation" / "client isolation"** in the router's wifi settings. If it's on, phones can reach the router but not the laptop.

### Windows laptop
1. When Windows asks about the new network, choose **Private** (or later: Settings → Network & internet → Wi-Fi → your network → *Private network*).
2. Allow the quiz through the firewall. Open **PowerShell as Administrator** and run once:

   ```powershell
   netsh advfirewall firewall add rule name="LAN Quiz" dir=in action=allow protocol=TCP localport=8080
   ```

   (If Windows pops up "Allow Node.js to communicate?" the first time you run `npm start`, tick **Private networks** and allow.)

### Linux / macOS laptop
- Ubuntu: `sudo ufw allow 8080/tcp` (skip if `sudo ufw status` says inactive).
- macOS: allow incoming connections for `node` when asked.

### Phones: the #1 cause of "it doesn't load"
- Join the quiz wifi. If the phone says *"No internet, stay connected?"* choose **Yes / Stay connected**.
- **Turn mobile data OFF**, otherwise Android may quietly send the request over mobile data and never reach the laptop.
- Set **screen timeout to the maximum** (plain web pages can't keep the screen awake). "Do not disturb" helps too.

### Check every phone
Open the team URL on each phone. On the dashboard every logged-in team gets a **green dot** and the header says *"N of N phones connected"*. A red dot means logged in but not responding (wifi dropped / screen asleep). Quick check from any device: `http://<laptop-ip>:8080/ping` should say `ok`.

> **Rehearse with real phones in the real room a few days early.** It's the only way to find wifi range, router or phone problems with time to fix them.

### Start the real event clean
Logins from the rehearsal are remembered. Start the event with:

```bash
npm run fresh
```

This archives the old state (renamed with a timestamp) and starts empty: no logins, no scores.

---

## 4. Running the quiz (host)

1. Teams log in; their cards show **not started / ready** with green dots.
2. Pick a round in the dropdown and press **Start**. The timer starts for everyone at once; phones show all of that round's questions on one screen, answerable in any order.
3. Teams tap **Submit** when done (or the phone submits automatically at 0:00). Cards flip to **✔ Submitted** with the time taken. While the round is running, answers are **not** shown on the dashboard, so nobody can copy from the screen.
4. When the timer ends, or you press **Lock now** once everyone is in (the dashboard nudges you), results **reveal**: each answer marked green/red, the score, and time taken.
5. **Auto-check got a typed answer wrong?** Click any answer row to flip its mark. Questions with no auto-answer show `?` for you to mark by hand.
6. **Hide results** blanks the cards if the laptop screen is visible to the room.
7. Start the next round. The cards clear, but **the scores are kept on the leaderboard**.

### Leaderboard and results
Below the team cards, the **Leaderboard** adds up every locked round plus correct special questions. Ties go to the team with the lower total time.
- Hand-corrections update the totals automatically.
- **✕** next to a round's name removes it from the totals (e.g. a practice round, or one you restarted).
- **Download results (CSV)** saves a spreadsheet (opens in Excel / Google Sheets) with every team's per-round scores, total and rank. Keep it for certificates and records.
- **Reset leaderboard** starts the totals again from zero (download the CSV first).

The projector never shows scores, so it's always safe for the room to see. Read winners from the dashboard.

### Special question (to one team)
Useful for buzzer rounds, "chance" or "penalty" questions, or tie-breakers. Choose a team and a special question at the bottom of the dashboard and press **Push to team**. That one phone shows a full-screen question with its own short timer. The answer appears in the list, marked correct/wrong. Pushed to the wrong team? **Cancel**. Correct specials add 1 point each on the leaderboard.

### Projector screen
Open `/projector` in a second browser window on the laptop and drag it to the HDMI/projector display (F11 for full-screen). Keep `/dashboard` on the laptop's own screen. It shows:
- **Idle:** "waiting for the host".
- **Running:** the round name, the countdown and every question in the round, fitted to the screen.
- **A special question:** the team's name, the question and its countdown.
- **Locked:** "round complete". Never answers or scores.

To open the dashboard or projector from **another device** (e.g. a second laptop driving the projector), add `?key=<hostKey>` to the address once; it's remembered on that device.

### Things that can go wrong
| Problem | What to do |
|---|---|
| "Already logged in on another device" | A second phone tried, or the team cleared their browser. Press **Release login** on their card; they log in again. |
| A phone dies or is swapped | **Release login**, log in on the new phone. Answers synced before it died are kept and auto-submitted at 0:00. |
| Phone loses wifi mid-round | Nothing to do. Answers stay on the phone (an orange "No connection" strip shows) and sync when wifi returns. If it's still offline at 0:00, the server uses the last answers the phone synced (card shows **auto-locked**). |
| Laptop / server crashes | `npm start` again. Phones reconnect by themselves; scores and the leaderboard are kept. |
| Page won't load on a phone | Mobile data off? Same wifi? Firewall rule added? Router isolation off? Try `http://<laptop-ip>:8080/ping`. |
| Edited `questions.json` by hand | Press **Reload questions** (not allowed while a round is running). Mistakes are explained in a red box and the old questions stay in use. |

---

## 5. Writing questions

### The easy way: `/admin`
Open `/admin` (also linked from the dashboard):
- **+ Add round**: name it and set its timer. Add as many rounds as you like.
- **+ Add question**: **Multiple choice** or **One-word answer**. Tap the correct option (or tick "no single correct answer" to mark by hand), or list every accepted spelling for a one-word answer.
- **↑ / ↓ / ✕** to reorder or delete rounds and questions.
- **Save changes** checks everything and writes it to `questions.json`. Mistakes (e.g. a blank question) are listed in plain English and nothing is saved until they're fixed.
- Saving is blocked only while a round is actually running.

### The file way: `questions.json`
Edit it in any text editor for bulk changes, then press **Reload questions** on the dashboard.

```json
{
  "rounds": [
    {
      "name": "Round 1",
      "timerSeconds": 30,
      "questions": [
        { "type": "mcq", "text": "Which planet is known as the Red Planet?",
          "options": ["Venus", "Mars", "Jupiter", "Mercury"], "answer": "B" },
        { "type": "text", "text": "Chemical symbol for gold?", "answer": ["Au"] },
        { "type": "text", "text": "An open-ended one you will mark yourself", "answer": null }
      ]
    }
  ],
  "specials": [
    { "type": "mcq", "text": "Which data structure works on FIFO?",
      "options": ["Stack", "Queue", "Tree", "Graph"], "answer": "B", "timerSeconds": 15 }
  ]
}
```

| Field | Meaning |
|---|---|
| `rounds` | Timed blocks of questions. Each has a `name`, optional `timerSeconds` (3–3600), and `questions`. |
| `specials` | Questions you can push to a single team, each with an optional `timerSeconds`. |
| `type` | `"mcq"` (multiple choice) or `"text"` (short typed answer). |
| `options` | MCQ only: 2–8 choices, shown as A, B, C, D… |
| `answer` (mcq) | The **letter** of the correct option (`"A"`, `"B"`…), or `null` to mark by hand. |
| `answer` (text) | A list of accepted answers, e.g. `["World Wide Web", "www"]`. Matching ignores capitals, extra spaces, accents and punctuation (`"U.S.A."` matches `"USA"`), but words must otherwise match, so list every wording you'd accept. `null` = mark by hand. |

The most common file mistake is a missing comma or quote. The error message says exactly which round and question to look at.

---

## 6. Handing over to next year's organisers

1. Copy or clone this repo onto the host laptop and install Node.js.
2. Edit `config.json`: new `eventName`, your own `hostKey`, your team list.
3. Write the questions in `/admin`.
4. Rehearse in the real room with real phones (§3).
5. On the day: `npm run fresh`, then run the quiz.
6. Afterwards: **Download results (CSV)** and keep it.

Found a bug or made it better? Open an issue or pull request on GitHub so the next batch benefits.

---

## 7. How it stays reliable

- **Server clock is the truth.** Every phone and the dashboard sync to it, so all countdowns agree. At 0:00 inputs lock and the phone auto-submits.
- **First submission wins, retries are safe.** A phone that lost the reply to its submit retries and gets the same answer back; nobody can change answers after submitting.
- **Simultaneous submits** are handled one at a time (Node is single-threaded), each written to `data/state.json` and appended to `data/submissions.jsonl`, an audit trail of every accepted submission and host action.
- **Answers are stored on the phone as you type** and synced about once a second, so a refresh, a wifi blip or a dead battery doesn't lose them.
- **One phone per team:** the first device to log in owns the team until the host presses *Release login*.
- **Phones never receive the correct answers.**
- Light on the network: each phone sends one small request per second, so a basic router copes with dozens of teams.

## 8. Limits worth knowing

- Plain HTTP on a private network: anyone on the quiz wifi could in principle read traffic. Use a wifi password and don't reuse `hostKey` anywhere else.
- Phones can't be forced to stay awake over plain HTTP; see the screen-timeout advice.
- One event at a time on one laptop. History lives in the `data/` folder (and your downloaded CSVs).

## 9. For developers

- `server.js`: the whole server, Node built-ins only.
- `public/team.html`, `dashboard.html`, `admin.html`, `projector.html`: the four screens (inline CSS/JS, system fonts, no external requests).
- `public/themes.css`, `public/theme-picker.js`: shared themes (Classic, Neon, Monochrome, Nature); a new theme is CSS-only. `public/event-name.js` fills in `eventName`.
- `npm test`: runs `test/simulate.js`, which simulates 10 teams against a real server: simultaneous submits, late submits, drafts, lockouts, specials, the leaderboard and CSV export, the admin editor, and restart recovery (about 15 seconds).

## License

[MIT](LICENSE): free to use, change and share.
