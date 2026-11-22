import os
import sqlite3
import time
from contextlib import asynccontextmanager, closing, contextmanager
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import AwareDatetime, BaseModel, Field, StringConstraints

ROOT = Path(__file__).resolve().parent
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Reference = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40, pattern=r"^[a-zA-Z0-9_-]+$")]
Amount = Annotated[Decimal, Field(ge=0, le=999999999, decimal_places=2)]
Minutes = Annotated[int, Field(ge=1, le=10080)]
Trigger = Literal["any_bid", "rank_change", "leader_change"]
REASONS = {
    "any_bid": "Bid received in the trigger window",
    "rank_change": "Supplier ranking changed",
    "leader_change": "Lowest bidder changed",
}


class RFQInput(BaseModel):
    id: Reference
    name: Name
    route: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] = ""
    start_at: AwareDatetime
    close_at: AwareDatetime
    forced_close_at: AwareDatetime
    service_date: date
    trigger_window: Minutes
    extension_duration: Minutes
    trigger_rule: Trigger


class BidInput(BaseModel):
    carrier: Name
    freight: Amount
    origin: Amount
    destination: Amount
    transit_days: Annotated[int, Field(ge=1, le=3650)]
    valid_until: date


def now_ms():
    return time.time_ns() // 1_000_000


@contextmanager
def database(write=False):
    db = sqlite3.connect(os.getenv("RFQ_DB", str(ROOT / "auction.sqlite3")), timeout=10)
    with closing(db), db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db


def create_bid(db, rfq, bid, now):
    if status(rfq, now) != "Active":
        raise HTTPException(409, "This auction is not accepting bids.")
    scores = [int(getattr(bid, field) * 100) for field in ("freight", "origin", "destination")]
    total = sum(scores)
    if not total:
        raise HTTPException(422, "Total charges must be greater than zero.")
    key = bid.carrier.casefold()
    before = ranking(db, rfq["id"])
    prior = next((row for row in before if row["supplier_key"] == key), None)
    if prior and total >= prior["total"]:
        raise HTTPException(422, "A revised bid must be lower than your previous quote.")
    bid_id = db.execute(
        """INSERT INTO bids (rfq_id, carrier, supplier_key, freight, origin, destination,
           transit_days, valid_until, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (rfq["id"], bid.carrier, key, *scores, bid.transit_days, bid.valid_until.isoformat(), now),
    ).lastrowid
    db.execute(
        "INSERT INTO activity (rfq_id, bid_id, kind, occurred_at) VALUES (?, ?, 'bid', ?)",
        (rfq["id"], bid_id, now),
    )
    old_close = rfq["close_at"]
    new_close = min(rfq["forced_close_at"], old_close + rfq["extension_duration"] * 60_000)
    if now < old_close - rfq["trigger_window"] * 60_000 or new_close <= old_close:
        return
    old_order = [row["supplier_key"] for row in before]
    new_order = [row["supplier_key"] for row in ranking(db, rfq["id"])]
    rule = rfq["trigger_rule"]
    triggered = {
        "any_bid": True,
        "rank_change": old_order != new_order,
        "leader_change": old_order[:1] != new_order[:1],
    }[rule]
    if triggered:
        db.execute("UPDATE rfqs SET close_at = ? WHERE id = ?", (new_close, rfq["id"]))
        db.execute(
            """INSERT INTO activity (rfq_id, bid_id, kind, occurred_at, reason,
               previous_close_at, new_close_at) VALUES (?, ?, 'extension', ?, ?, ?, ?)""",
            (rfq["id"], bid_id, now, REASONS[rule], old_close, new_close),
        )


def status(rfq, now):
    if now >= rfq["close_at"]:
        return "Force Closed" if rfq["close_at"] == rfq["forced_close_at"] else "Closed"
    return "Scheduled" if now < rfq["start_at"] else "Active"


def ranking(db, rfq_id):
    return db.execute(
        """SELECT * FROM (
               SELECT bids.*, ROW_NUMBER() OVER (
                   PARTITION BY supplier_key ORDER BY id DESC
               ) AS latest FROM bids WHERE rfq_id = ?
           ) WHERE latest = 1 ORDER BY total, id""",
        (rfq_id,),
    ).fetchall()


def get_rfq(db, rfq_id):
    row = db.execute("SELECT * FROM rfqs WHERE id = ?", (rfq_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "RFQ not found.")
    return row


def summary(db, rfq, now):
    leaders = ranking(db, rfq["id"])
    count = db.execute("SELECT COUNT(*) FROM bids WHERE rfq_id = ?", (rfq["id"],)).fetchone()[0]
    return {
        **dict(rfq), "status": status(rfq, now), "server_now": now,
        "lowest_bid": leaders[0]["total"] if leaders else None,
        "bid_count": count, "supplier_count": len(leaders),
    }


def detail(db, rfq, now):
    rfq_id = rfq["id"]
    ranks = {row["id"]: index for index, row in enumerate(ranking(db, rfq_id), 1)}
    bids = db.execute("SELECT * FROM bids WHERE rfq_id = ? ORDER BY total, id", (rfq_id,))
    events = db.execute(
        """SELECT activity.*, bids.carrier, bids.total FROM activity JOIN bids
           ON bids.id = activity.bid_id WHERE activity.rfq_id = ? ORDER BY activity.id DESC""",
        (rfq_id,),
    )
    return {
        **summary(db, rfq, now),
        "bids": [{**dict(row), "rank": ranks.get(row["id"])} for row in bids],
        "activity": [dict(row) for row in events],
    }


def seed(db):
    now = now_ms()
    service = date.fromtimestamp((now + 7 * 86_400_000) / 1000).isoformat()
    demos = [
        ("RFQ-1042", "Shanghai to Los Angeles", "CNSHA → USLAX", -60, 40, 80, "leader_change"),
        ("RFQ-1041", "Rotterdam to New York", "NLRTM → USNYC", -90, 70, 115, "rank_change"),
        ("RFQ-1040", "Singapore to Hamburg", "SGSIN → DEHAM", -180, -45, -15, "any_bid"),
    ]
    for rfq_id, name, route, start, close, forced, trigger in demos:
        db.execute(
            "INSERT INTO rfqs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rfq_id, name, route, now + start * 60_000, now + close * 60_000,
             now + close * 60_000, now + forced * 60_000, service, 10, 5, trigger),
        )
    rfq = get_rfq(db, "RFQ-1042")
    demo_bids = [
        ("OceanBridge Logistics", 2580, 340, 260, 19),
        ("Pacific Freight Co.", 2430, 300, 220, 17),
        ("Meridian Shipping", 2250, 320, 280, 16),
    ]
    for index, (carrier, freight, origin, destination, transit_days) in enumerate(demo_bids):
        bid = BidInput(carrier=carrier, freight=freight, origin=origin, destination=destination,
                       transit_days=transit_days, valid_until=service)
        create_bid(db, rfq, bid, now - (24 - index * 6) * 60_000)


@asynccontextmanager
async def lifespan(app):
    with closing(sqlite3.connect(os.getenv("RFQ_DB", str(ROOT / "auction.sqlite3")))) as db:
        db.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
    if os.getenv("RFQ_DEMO", "1") == "1":
        with database(write=True) as db:
            if not db.execute("SELECT 1 FROM rfqs LIMIT 1").fetchone():
                seed(db)
    yield


app = FastAPI(title="FreightDesk RFQ Auctions", lifespan=lifespan)


@app.get("/api/rfqs")
def list_rfqs():
    with database() as db:
        now = now_ms()
        rows = db.execute("SELECT * FROM rfqs ORDER BY start_at DESC, id")
        return [summary(db, rfq, now) for rfq in rows]


@app.post("/api/rfqs", status_code=201)
def add_rfq(data: RFQInput):
    start, close, forced = (int(value.timestamp() * 1000)
                            for value in (data.start_at, data.close_at, data.forced_close_at))
    if not start < close < forced:
        raise HTTPException(422, "Start time must precede bid close, and forced close must follow bid close.")
    rfq_id = data.id.upper()
    with database(write=True) as db:
        if db.execute("SELECT 1 FROM rfqs WHERE id = ?", (rfq_id,)).fetchone():
            raise HTTPException(409, "This RFQ reference already exists.")
        db.execute(
            "INSERT INTO rfqs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rfq_id, data.name, data.route, start, close, close, forced,
             data.service_date.isoformat(), data.trigger_window, data.extension_duration, data.trigger_rule),
        )
        return detail(db, get_rfq(db, rfq_id), now_ms())


@app.get("/api/rfqs/{rfq_id}")
def show_rfq(rfq_id: str):
    with database() as db:
        return detail(db, get_rfq(db, rfq_id), now_ms())


@app.post("/api/rfqs/{rfq_id}/bids", status_code=201)
def submit_bid(rfq_id: str, bid: BidInput):
    with database(write=True) as db:
        rfq = get_rfq(db, rfq_id)
        now = now_ms()
        create_bid(db, rfq, bid, now)
        return detail(db, get_rfq(db, rfq_id), now)


dist = ROOT.parent / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
