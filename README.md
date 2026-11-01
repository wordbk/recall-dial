# Recall Dial

An R1 creation that shows one stretch of your saves from the past each day.
It pulls from three Notion databases: Database of Stuff, Commonplace Book,
and Resources to make things.

- **Scroll wheel:** step through everything saved within about 10 days of today's pick
- **Side button:** open the detail sheet (why it's interesting, notes, a QR code to open the link on your phone)
- **Orange tick** on the bottom track marks the day it drew

## Files

- `src/worker.js`: the relay. Holds your Notion token, picks the day, returns the saves.
- `public/index.html`: the screen on the R1 (240 × 282).
- `public/install.html`: shows the QR code the R1 scans to install.
- `wrangler.toml`: Cloudflare settings.

## Set up (about 15 minutes, once)

### 1. Notion: make a key and share the three databases

1. Go to notion.so/profile/integrations and click **New integration**.
2. Name it `Recall Dial`, type **Internal**, and pick your workspace.
3. Under capabilities, leave only **Read content** on. (Version 2 will need "Update content" to save your spoken notes.)
4. Copy the token. It starts with `ntn_`. Keep it private.
5. Open each database (Stuff, Commonplace Book, Resources to make things), click **•••**, then **Connections**, then add **Recall Dial**.

### 2. Cloudflare: put the relay online (free tier)

From this folder in Terminal:

```
npx wrangler login
npx wrangler deploy
npx wrangler secret put NOTION_TOKEN     # paste the ntn_ token
npx wrangler secret put DIAL_KEY         # make up a long random phrase
```

`deploy` prints your address, something like `https://recall-dial.YOURNAME.workers.dev`.

### 3. Check it

Open `https://recall-dial.YOURNAME.workers.dev/api/today?k=YOUR_DIAL_KEY`.
You should see a list of saves. If it says a database is "not shared with the
integration," redo step 1.5 for that one.

### 4. Install on the R1

1. On your laptop, open `https://recall-dial.YOURNAME.workers.dev/install.html?k=YOUR_DIAL_KEY`.
2. On the R1, open the creations card, tap **add via QR code**, and scan it.

To push an update later: run `npx wrangler deploy`, then open the install page with `&v=2` added and rescan.

## Preview without the R1

Open `public/index.html?demo=1` in a browser. Arrow keys act as the scroll wheel; Escape is the side button.

## Settings

In `wrangler.toml`:

- `START_DATE`: the earliest day it can draw from (default 2019-01-01)
- `TIMEZONE`: decides when "today" rolls over (default New York)

It never picks anything saved in the last 30 days.
