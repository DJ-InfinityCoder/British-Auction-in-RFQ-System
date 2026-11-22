# FreightDesk · British Auction for RFQs

FreightDesk is a FastAPI and React take-home project for freight procurement. Buyers create RFQs and suppliers submit open, descending quotes. The API extends the bidding window when the configured trigger fires and enforces the forced close.

## Run locally

Use Python 3.12+ and Node.js 22.12+.

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
npm.cmd ci
npm.cmd run build
.venv/Scripts/python -m uvicorn backend.main:app
```

Open http://127.0.0.1:8000 for the app or http://127.0.0.1:8000/docs for interactive API documentation. On macOS/Linux, use `.venv/bin/python` and `npm`. For frontend development, start the API as above and run `npm run dev` in a second terminal. Vite proxies `/api` to port 8000.

The first run seeds sample auctions relative to the startup time. Set `RFQ_DEMO=0` before starting to disable seeding on an empty database. Set `RFQ_DB` to use a different SQLite file. The default is `backend/auction.sqlite3`.

## Try an extension

1. Click **New RFQ**. Keep the default start time, set bid close five minutes from now, and set forced close 15 minutes from now. Fill in the name, reference, and service date.
2. Leave the trigger window at 10 minutes and extension duration at five minutes. Select **Any bid received**.
3. Submit a quote. Confirm the lowest bid and leaderboard update, then open **Activity log** to see the previous close, new close, and extension reason.
4. Submit a lower revision from the same carrier. Repeat until the current close equals forced close. A bid at or after that time is rejected, and the auction reports **Force Closed**.

## Verify

```powershell
.venv/Scripts/python -m unittest discover -s tests -v
npm.cmd run build
```

- [High-level design and architecture diagram](docs/architecture.md)
- [Database schema and data model](docs/architecture.md#database-schema)
- [Executable SQLite schema](backend/schema.sql)
