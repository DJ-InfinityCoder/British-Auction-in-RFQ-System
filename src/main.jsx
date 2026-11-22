import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronRight, Clock3, Gavel, LayoutList, Plus, Search, Settings2, Ship, Timer, Trophy, X, Zap } from 'lucide-react';
import './styles.css';

const triggers = {
  any_bid: 'Any bid received',
  rank_change: 'Any supplier rank change',
  leader_change: 'Lowest bidder changes',
};
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const price = (cents) => cents == null ? '—' : usd.format(cents / 100);
const dateTime = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (value) => new Date(value + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

async function api(path, data) {
  const response = await fetch('/api/rfqs' + path, data && {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    const message = Array.isArray(error.detail)
      ? error.detail.map((item) => item.loc.at(-1).replaceAll('_', ' ') + ': ' + item.msg).join(' · ')
      : error.detail;
    throw new Error(message || 'The request could not be completed.');
  }
  return response.json();
}

function Status({ value }) {
  return <span className={'status ' + value.toLowerCase().replaceAll(' ', '-')}><i />{value}</span>;
}

function Field({ label, name, type = 'text', required = true, ...rest }) {
  return <label className="field">{label}<input name={name} type={type} required={required} {...rest} /></label>;
}

function localInput(offset) {
  const time = new Date(Date.now() + offset * 60000);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function FormDialog({ mode, onClose, onSave }) {
  const dialog = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const create = mode === 'rfq';

  useEffect(() => { dialog.current.showModal(); }, []);

  async function submit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (create) {
      for (const field of ['start_at', 'close_at', 'forced_close_at']) {
        data[field] = new Date(data[field]).toISOString();
      }
    }
    setBusy(true);
    setError('');
    try {
      await onSave(data);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><div><h2>{create ? 'Create RFQ' : 'Submit a quote'}</h2>
        <p>{create ? 'Schedule a British reverse auction.' : 'Enter your carrier’s charges in USD.'}</p></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={20} /></button>
      </div>
      <div className="form-grid">
        {create ? <>
          <Field label="RFQ name" name="name" maxLength={100} placeholder="e.g. Shanghai to Los Angeles" />
          <Field label="Reference ID" name="id" maxLength={40} pattern="[a-zA-Z0-9_\-]+" placeholder="e.g. RFQ-1043" />
          <Field label="Route (optional)" name="route" maxLength={100} required={false} placeholder="e.g. CNSHA → USLAX" />
          <Field label="Pickup / service date" name="service_date" type="date" />
          <Field label="Bid start" name="start_at" type="datetime-local" defaultValue={localInput(0)} />
          <Field label="Bid close" name="close_at" type="datetime-local" defaultValue={localInput(30)} />
          <Field label="Forced close" name="forced_close_at" type="datetime-local" defaultValue={localInput(60)} />
          <label className="field">Extension trigger<select name="trigger_rule">{Object.entries(triggers).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <Field label="Trigger window (minutes)" name="trigger_window" type="number" min="1" max="10080" defaultValue="10" />
          <Field label="Extension duration (minutes)" name="extension_duration" type="number" min="1" max="10080" defaultValue="5" />
        </> : <>
          <Field label="Carrier name" name="carrier" maxLength={100} placeholder="Company name" />
          {['freight', 'origin', 'destination'].map((name) => <Field key={name} label={name[0].toUpperCase() + name.slice(1) + ' charges'} name={name} type="number" min="0" max="999999999" step="0.01" defaultValue={name === 'freight' ? undefined : '0'} />)}
          <Field label="Transit time (days)" name="transit_days" type="number" min="1" max="3650" />
          <Field label="Quote valid until" name="valid_until" type="date" />
        </>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy}>{busy ? 'Saving…' : create ? 'Create RFQ' : 'Submit quote'}</button></div>
    </form>
  </dialog>;
}

function Countdown({ deadline, now }) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function AuctionDetail({ rfq, now, tab, setTab, openBid }) {
  const leader = rfq.bids.find((bid) => bid.rank === 1);
  return <>
    <div className="detail-heading">
      <div><div className="meta"><span>{rfq.id}</span><Status value={rfq.status} /></div>
        <h2>{rfq.name}</h2>
        <div className="route"><Ship size={15} />{rfq.route || 'Freight RFQ'} <span>·</span> <CalendarDays size={14} /> Pickup {day(rfq.service_date)}</div>
      </div>
      <button className="button primary" disabled={rfq.status !== 'Active' || now >= rfq.close_at} onClick={openBid}><Plus size={17} /> Submit quote</button>
    </div>
    <div className="metrics">
      <div className="metric"><span className="metric-icon teal"><Trophy size={17} /></span><span>Lowest bid</span><strong>{price(rfq.lowest_bid)}</strong><small>{leader?.carrier || 'Awaiting quotes'}</small></div>
      <div className="metric"><span className="metric-icon blue"><Timer size={17} /></span><span>{rfq.status === 'Scheduled' ? 'Starts in' : 'Time remaining'}</span><strong className="clock"><Countdown deadline={rfq.status === 'Scheduled' ? rfq.start_at : rfq.close_at} now={now} /></strong><small>Bid close · {dateTime(rfq.close_at)}</small></div>
      <div className="metric"><span className="metric-icon amber"><Clock3 size={17} /></span><span>Forced close</span><strong className="date-value">{dateTime(rfq.forced_close_at)}</strong><small>Hard bidding deadline</small></div>
    </div>
    <nav className="tabs" aria-label="Auction details">
      {[['bids', 'Supplier bids', LayoutList], ['activity', 'Activity log', Activity], ['rules', 'Auction rules', Settings2]].map(([key, label, Icon]) =>
        <button key={key} aria-pressed={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}><Icon size={16} />{label}{key === 'bids' && <span className="count">{rfq.bid_count}</span>}</button>)}
    </nav>
    {tab === 'bids' && <section className="tab-body"><div className="section-heading"><div><h3>Supplier leaderboard</h3><p>{rfq.supplier_count} {rfq.supplier_count === 1 ? 'supplier' : 'suppliers'} · Ranked by total quote in USD</p></div></div>
      {rfq.bids.length ? <div className="table-wrap"><table>
        <thead><tr><th scope="col">Rank</th><th scope="col">Carrier</th><th scope="col">Total quote</th><th scope="col">Transit</th><th scope="col">Quote details</th></tr></thead>
        <tbody>{rfq.bids.map((bid) => <tr key={bid.id}>
          <td><span className={'rank ' + (bid.rank === 1 ? 'first' : '')}>{bid.rank ? 'L' + bid.rank : '—'}</span></td>
          <td><strong>{bid.carrier}</strong><small>{bid.rank ? dateTime(bid.submitted_at) : 'Superseded · ' + dateTime(bid.submitted_at)}</small></td>
          <td><strong>{price(bid.total)}</strong></td><td>{bid.transit_days} days</td>
          <td><details><summary>View <ChevronRight size={13} /></summary><dl>
            <div><dt>Freight</dt><dd>{price(bid.freight)}</dd></div>
            <div><dt>Origin</dt><dd>{price(bid.origin)}</dd></div>
            <div><dt>Destination</dt><dd>{price(bid.destination)}</dd></div>
            <div><dt>Valid until</dt><dd>{day(bid.valid_until)}</dd></div>
          </dl></details></td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">No quotes have been submitted.</p>}
    </section>}
    {tab === 'activity' && <section className="tab-body"><div className="section-heading"><div><h3>Activity log</h3><p>Quote submissions and extensions, most recent first</p></div></div>
      {rfq.activity.length ? <ol className="events">{rfq.activity.map((event) => <li key={event.id}>
        <span className={'metric-icon ' + (event.kind === 'extension' ? 'amber' : 'teal')}>{event.kind === 'extension' ? <Zap size={17} /> : <Check size={17} />}</span>
        <div><strong>{event.kind === 'extension' ? 'Bid close extended' : event.carrier + ' submitted a quote'}</strong>
        <p>{event.kind === 'extension' ? event.reason + ' · ' + dateTime(event.previous_close_at) + ' → ' + dateTime(event.new_close_at) : price(event.total)}</p></div>
        <time dateTime={new Date(event.occurred_at).toISOString()}>{dateTime(event.occurred_at)}</time>
      </li>)}</ol> : <p className="empty">No activity yet.</p>}
    </section>}
    {tab === 'rules' && <section className="tab-body"><div className="section-heading"><div><h3>British auction rules</h3><p>Extensions apply only to accepted bids in the trigger window.</p></div></div>
      <dl className="rules">
        <div><dt>Trigger window (X)</dt><dd>{rfq.trigger_window} minutes</dd></div>
        <div><dt>Extension duration (Y)</dt><dd>{rfq.extension_duration} minutes</dd></div>
        <div><dt>Extension trigger</dt><dd>{triggers[rfq.trigger_rule]}</dd></div>
        <div><dt>Scheduled start</dt><dd>{dateTime(rfq.start_at)}</dd></div>
        <div><dt>Original close</dt><dd>{dateTime(rfq.original_close_at)}</dd></div>
        <div><dt>Forced close</dt><dd>{dateTime(rfq.forced_close_at)}</dd></div>
      </dl>
    </section>}
  </>;
}

function App() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('bids');
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [clock, setClock] = useState(Date.now());
  const revision = useRef(0);
  const serverOffset = useRef(0);

  useEffect(() => {
    let disposed = false;
    async function refresh() {
      const version = revision.current;
      const requestedAt = Date.now();
      try {
        const [list, current] = await Promise.all([api(''), selected ? api('/' + selected) : null]);
        if (disposed || version !== revision.current) return;
        const serverNow = current?.server_now ?? list[0]?.server_now;
        if (serverNow) serverOffset.current = serverNow - (requestedAt + Date.now()) / 2;
        setClock(Date.now() + serverOffset.current);
        setRows(list);
        setDetail(current);
        setSelected((id) => id ?? list[0]?.id ?? null);
        setError('');
      } catch (failure) {
        if (!disposed) setError(failure.message);
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    refresh();
    const polling = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(polling); };
  }, [selected]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now() + serverOffset.current), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = detail?.id === selected ? detail : null;
  const filtered = rows.filter((rfq) =>
    (filter === 'All' || (filter === 'Closed' ? rfq.status.endsWith('Closed') : rfq.status === filter)) &&
    [rfq.name, rfq.id, rfq.route].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));

  async function save(data) {
    const creating = dialog === 'rfq';
    const result = await api(creating ? '' : '/' + selected + '/bids', data);
    revision.current++;
    serverOffset.current = result.server_now - Date.now();
    setClock(result.server_now);
    setRows((previous) => {
      const updated = previous.filter((rfq) => rfq.id !== result.id);
      return [...updated, result].sort((a, b) => b.start_at - a.start_at || a.id.localeCompare(b.id));
    });
    if (creating) {
      setFilter('All');
      setQuery('');
    }
    setDetail(result);
    setSelected(result.id);
    setTab('bids');
    setMobileDetail(true);
    setNotice(creating ? 'RFQ created.' : 'Quote submitted.');
    setDialog(null);
  }

  return <>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Ship size={22} /></span> FreightDesk</div>
      <div className="top-crumb"><ChevronRight size={15} /> Procurement <ChevronRight size={15} /> <span>RFQ auctions</span></div>
      <span className="workspace"><i /> Procurement workspace</span>
    </header>
    <main>
      <div className="page-heading"><div><h1>RFQ auctions</h1><p>Manage freight requests and track live supplier bidding.</p></div>
        <button className="button primary" onClick={() => { setNotice(''); setDialog('rfq'); }}><Plus size={18} /> New RFQ</button></div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <div className="notice" role="status"><Check size={16} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button></div>}
      <div className={'desk ' + (mobileDetail ? 'show-detail' : '')}>
        <aside className="auction-list" aria-label="Auction listing">
          <div className="list-heading"><h2><Gavel size={18} /> Auctions</h2><span className="count">{rows.length}</span></div>
          <div className="list-controls"><label className="search"><Search size={16} /><input aria-label="Search auctions" placeholder="Search auctions…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <select aria-label="Filter by auction status" value={filter} onChange={(event) => setFilter(event.target.value)}>{['All', 'Active', 'Scheduled', 'Closed'].map((value) => <option key={value}>{value}</option>)}</select></div>
          <div className="auction-items">
            {filtered.map((rfq) => <button key={rfq.id} className={'auction-item ' + (selected === rfq.id ? 'current' : '')} aria-pressed={selected === rfq.id} onClick={() => { setSelected(rfq.id); setTab('bids'); setMobileDetail(true); setNotice(''); }}>
              <div className="item-top"><span>{rfq.id}</span><Status value={rfq.status} /></div>
              <strong>{rfq.name}</strong>
              <div className="item-price"><span>Lowest bid</span><b>{price(rfq.lowest_bid)}</b></div>
              <div className="item-times"><span>Bid close <b>{dateTime(rfq.close_at)}</b></span><span>Forced close <b>{dateTime(rfq.forced_close_at)}</b></span></div>
              <ArrowRight className="item-arrow" size={15} />
            </button>)}
            {!filtered.length && <p className="empty">{loading ? 'Loading auctions…' : 'No auctions match this view.'}</p>}
          </div>
        </aside>
        <section className="auction-detail" aria-label="Selected auction">
          <button className="mobile-back button secondary" onClick={() => setMobileDetail(false)}><ArrowLeft size={16} /> Auctions</button>
          {current ? <AuctionDetail rfq={current} now={clock} tab={tab} setTab={setTab} openBid={() => { setNotice(''); setDialog('bid'); }} /> :
            <p className="empty">{selected || loading ? 'Loading auction…' : 'Create an RFQ to start an auction.'}</p>}
        </section>
      </div>
      <footer><span><Ship size={14} /> FreightDesk</span><a href="/docs" target="_blank" rel="noreferrer">API documentation <ArrowUpRight size={13} /></a></footer>
    </main>
    {dialog && <FormDialog mode={dialog} onClose={() => setDialog(null)} onSave={save} />}
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
