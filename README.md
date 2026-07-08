# studioassistant-sync
# Studio Schedule — Belmont AET

**Live URL:** https://bradwintersmusic-cloud.github.io/studioassistant-sync/

Live schedule of all studio sessions and classes across AET facilities. Automatically updated every 30 minutes via GitHub Actions.

---

## ⚠️ Important — Do Not Edit `index.html` Directly

`index.html` is **auto-generated** by the GitHub Actions cron job. Any manual edits to `index.html` will be overwritten the next time the workflow runs (every 30 minutes).

**All template changes must be made in:**
```
scripts/studioassistant-syncv5.js
```

---

## How It Works

1. GitHub Actions triggers the sync workflow every 30 minutes via cron
2. `studioassistant-syncv5.js` authenticates with the StudioAssistant API using two-step JWT auth
3. The script fetches live session and class booking data
4. It generates a complete `index.html` from the data and template
5. The generated file is committed and pushed to `main`
6. GitHub Pages serves the updated page

---

## Workflow File

```
.github/workflows/sync.yml
```

To pause or resume auto-updates, disable/enable this workflow in the GitHub Actions tab.

---

## Git Conflict Resolution

Because `index.html` is written by the GitHub Actions bot every 30 minutes, pulling after the bot has run will cause a conflict. Use this sequence:

```bash
git pull
# if conflict on index.html:
git checkout --theirs index.html
git add index.html
git rebase --continue
git push
```

Requires `pull.rebase true` set globally in git config.

---

## Making Template Changes

1. Open `scripts/studioassistant-syncv5.js`
2. Find the HTML template string (the large backtick string containing the full page HTML)
3. Make your changes inside the template
4. Commit and push — the next cron run will apply your changes to `index.html`
5. To test immediately: go to GitHub → Actions → sync workflow → Run workflow manually

---

## Tech Stack

- Node.js (script)
- GitHub Actions (cron automation)
- StudioAssistant API (JWT auth)
- GitHub Pages hosting

---

## Repo

`bradwintersmusic-cloud/studioassistant-sync`
Maintained by Brad Winters