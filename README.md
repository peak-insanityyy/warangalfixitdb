# FixWarangal

**Civic issue reporting for Warangal that closes the loop.** Citizens report problems with a photo and location, duplicates collapse into an "I see this too" vote, every category has an SLA timer with auto-escalation to a supervisor, and an issue only counts as resolved after an officer uploads an **after photo** and citizens **confirm** it.

> Hackathon prototype. Not load-tested; see [Limitations](#limitations).

## Why

Most complaint portals fail in three ways: duplicate tickets bury real problems, nobody is held to a deadline, and "resolved" is just a button an officer can click. FixWarangal addresses each one.

## Features

| Feature | How it works |
|---|---|
| **Report with context** | Description, up to 3 photos, optional GPS. The category is detected automatically and routed to a team. |
| **Duplicate handling** | A new report with the **same category**, within **100 m**, of an open issue created in the last **50 minutes** becomes an **"I see this too"** vote instead of a new ticket. Uses a MongoDB `2dsphere` index with `$near`. |
| **Priority ranking** | Each issue has a `pr` score: severity weight x 5, plus 10 per vote, plus 50 on escalation or reopen. The feed is sorted by it (indexed). |
| **SLA timers and escalation** | Every category has a deadline. If an issue is not fixed in time, a background job auto-escalates it to the supervisor and can call a webhook. |
| **Evidence-based resolution** | Officers must upload an **after photo** to mark an issue fixed. Status becomes *Fixed, awaiting citizens*, not *Resolved*. |
| **Citizen confirmation** | The reporter and everyone who voted can **confirm or reopen**. A reopened issue goes straight back to the supervisor with a shorter deadline. |
| **Public dashboard** | Totals, resolution rate, average time to fix, category breakdown, live SLA countdowns and a full timeline per issue. |

### Default SLAs

| Category | SLA before escalation |
|---|---|
| Garbage and sanitation | 24 h |
| Water supply | 48 h |
| Drainage | 72 h |
| Streetlights | 96 h |
| Potholes and roads | 120 h |
| Other | 168 h |

Edit the `CATS` table in `server.js` to change them.

### Issue lifecycle

```
Reported -> Assigned -> In Progress -> Fixed (after photo required) -> Resolved
                                            |
                                            +-- citizens say "not fixed" -> reopened + escalated
```

- Closes when at least half of the reporter and voters confirm, or when the confirmation window (72 h by default) ends without a majority saying "not fixed".
- Reopens when at least half say "not fixed" and they outnumber confirmations.

## Tech stack

- **Frontend:** single static `public/index.html` (vanilla JS, no build step)
- **Backend:** Node.js, Express
- **Database:** MongoDB (Atlas or local), official `mongodb` driver
- **Security middleware:** Helmet, express-rate-limit

## Getting started

### Prerequisites

- Node.js 18 or newer
- A MongoDB database. The easiest option is a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster.

### Install

```bash
git clone https://github.com/<your-username>/fixwarangal.git
cd fixwarangal
npm install
```

Make sure `index.html` is inside the `public/` folder.

### Configure and run

**macOS / Linux**
```bash
export OFFICER_KEY="choose-a-password"
export SUPERVISOR_KEY="choose-another"
export MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/fixwarangal?appName=Cluster0"
npm start
```

**Windows (PowerShell)**
```powershell
$env:OFFICER_KEY="choose-a-password"
$env:SUPERVISOR_KEY="choose-another"
$env:MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/fixwarangal?appName=Cluster0"
npm start
```

Open <http://localhost:3000>. When the server is running you will see `FixWarangal on :3000`.

> Never commit your connection string or keys. The included `.gitignore` excludes `.env` and `start.ps1`.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OFFICER_KEY` | yes | none | Key officers enter in **Officer view** |
| `SUPERVISOR_KEY` | yes | none | Supervisor key (same powers, shown as supervisor) |
| `MONGODB_URI` | no | `mongodb://127.0.0.1:27017/fixwarangal` | Database connection string |
| `PORT` | no | `3000` | HTTP port |
| `DUP_WINDOW_MIN` | no | `50` | Duplicate window in minutes |
| `DUP_RADIUS_M` | no | `100` | Duplicate radius in metres |
| `SLA_SCALE` | no | `1` | Multiplies all SLAs. Use `0.001` to demo escalation in minutes |
| `CONFIRM_HOURS` | no | `72` | How long citizens have to confirm a fix |
| `SUPERVISOR_WEBHOOK` | no | none | URL that receives a JSON `{text}` POST on each escalation (e.g. a Slack webhook) |
| `TRUST_PROXY` | no | `0` | Set to `1` behind a reverse proxy so rate limits use the real client IP |

## Try it

1. Post a problem and click **Use my exact location**.
2. Post the same kind of problem again from the same spot: it is added as an "I see this too" instead of a new ticket.
3. Click **Officer view**, enter `OFFICER_KEY`, open an issue and assign it. Try **Mark fixed** without a photo: it is refused.
4. Add an after photo and mark it fixed, then switch Officer view off and confirm or reopen as the reporter.
5. Restart with `SLA_SCALE=0.001`, post an issue and wait a few minutes to see auto-escalation.

## API

All writes must be `application/json`.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/issues` | none | List issues, highest priority first |
| `POST` | `/api/issues` | none | Create an issue, or add a vote if it duplicates a nearby one |
| `POST` | `/api/issues/:id/upvote` | none | "I see this too" (one per person per issue) |
| `POST` | `/api/issues/:id/verify` | reporter or voter | Body `{ "ok": true \| false }`: confirm or reopen |
| `POST` | `/api/issues/:id/status` | staff key | Body `{ "s": 1 \| 2 }`: assign or start work |
| `POST` | `/api/issues/:id/resolve` | staff key | Body `{ "after": <jpeg data URL>, "note": "" }`: mark fixed |
| `GET` | `/api/photo/:id/:b\|a/:n` | none | Before (`b`) or after (`a`) photo |
| `GET` | `/api/me` | staff key | Returns the role for the `x-key` header |

Staff endpoints expect the key in an `x-key` header.

## Abuse protection

- Per-IP rate limits (posting, voting, staff login attempts) and a global API limit
- Honeypot field and a minimum time-to-submit check
- One vote per person per issue, enforced by a unique database index
- Server-side validation of text, area, coordinates (Warangal bounding box) and JPEG photos
- Duplicate merging, so spam does not create piles of tickets
- Staff actions require a key, compared in constant time
- Helmet security headers and JSON-only writes

## Project structure

```
fixwarangal/
  server.js        Express API, duplicate detection, SLA watchdog
  package.json
  public/
    index.html     Frontend
```

## Limitations

- Votes are tied to an anonymous cookie, so clearing cookies allows another vote. Rate limits cap the damage, but real protection needs phone-OTP sign-in.
- Photos are stored inside MongoDB documents. Move them to object storage (S3 or similar) before real traffic.
- Category detection is keyword-based, not a trained model.
- One escalation level (supervisor). Staff share one key per role rather than individual accounts.
- Area dropdown coordinates are approximate and are used only when no GPS is attached.

## Roadmap

- Phone-OTP login for citizens and per-officer accounts
- Telugu, Hindi and English
- Image-based classification
- Multi-level escalation and notifications (SMS, WhatsApp)
- Mobile app

## License

MIT. Add a `LICENSE` file with your name before publishing.
