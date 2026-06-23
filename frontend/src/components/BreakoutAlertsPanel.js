"use client";

import { useState, useMemo } from 'react';
import { formatPrice, formatTime } from '../utils/formatters';

const URGENCY_CONFIG = {
  CRITICAL: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/40', dot: 'bg-red-500' },
  HIGH:     { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/40', dot: 'bg-orange-500' },
  MEDIUM:   { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/40', dot: 'bg-yellow-500' },
  LOW:      { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/40', dot: 'bg-slate-500' },
};

const STRAT_LABELS = {
  vcp: 'VCP', darvas: 'DARVAS', vol: 'VOL SURGE', rs: 'REL STR',
  tight: 'TIGHT', pocket: 'POCKET', w52: '52W HIGH', minervini: 'MINERVINI',
  ema: 'EMA COMP', gapup: 'GAP UP', momentum: 'MOMENTUM', earlybo: 'EARLY BO',
  momignition: 'MOM IGN', earnings: 'EARNINGS',
};

function UrgencyBadge({ urgency }) {
  const cfg = URGENCY_CONFIG[urgency] || URGENCY_CONFIG.LOW;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} animate-pulse`} />
      {urgency}
    </span>
  );
}

function ImpactBar({ score }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 85 ? 'bg-red-500' : pct >= 70 ? 'bg-orange-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-slate-500';
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 bg-slate-700 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-slate-300 w-7 text-right">{pct}</span>
    </div>
  );
}

function AlertCard({ alert }) {
  const [expanded, setExpanded] = useState(false);
  const stratLabel = STRAT_LABELS[alert.signal_source] || (alert.signal_source || 'BREAKOUT').toUpperCase();

  return (
    <div
      className="border border-slate-700 rounded-lg bg-slate-900 hover:border-slate-600 transition-all cursor-pointer"
      onClick={() => setExpanded(e => !e)}
    >
      <div className="p-3 flex items-start gap-3">
        {/* Symbol column */}
        <div className="flex-shrink-0 min-w-[90px]">
          <div className="font-bold text-slate-100 text-sm leading-tight">
            {(alert.symbol || '').replace('.NS', '')}
          </div>
          <div className="text-xs text-slate-400 truncate max-w-[90px]" title={alert.company_name}>
            {alert.company_name || ''}
          </div>
        </div>

        {/* Strategy badge */}
        <div className="flex-shrink-0">
          <span className="text-xs font-bold px-2 py-1 bg-cyan-500/20 text-cyan-300 rounded border border-cyan-500/30">
            {stratLabel}
          </span>
        </div>

        {/* Prices */}
        <div className="flex-1 grid grid-cols-3 gap-1 text-xs font-mono text-right">
          <div>
            <div className="text-slate-500 text-[10px] uppercase">Entry</div>
            <div className="text-green-400">{formatPrice(alert.entry_price)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-[10px] uppercase">Stop</div>
            <div className="text-red-400">{formatPrice(alert.stop_price)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-[10px] uppercase">Target</div>
            <div className="text-cyan-400">{formatPrice(alert.target1_price)}</div>
          </div>
        </div>

        {/* Impact + urgency */}
        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <UrgencyBadge urgency={alert.urgency} />
          <ImpactBar score={alert.impact_score} />
        </div>
      </div>

      {/* Time + sector row */}
      <div className="px-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {alert.sector && (
            <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded">
              {alert.sector}
            </span>
          )}
          {alert.cap && (
            <span className="text-xs text-slate-600">
              {alert.cap.toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {alert.vol_ratio != null && (
            <span className="text-xs text-slate-500">
              Vol {Number(alert.vol_ratio).toFixed(1)}x
            </span>
          )}
          <span className="text-xs text-slate-600">
            {formatTime(alert.triggered_at)}
          </span>
          <span className="text-xs text-slate-600">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded reasons */}
      {expanded && alert.reasons && alert.reasons.length > 0 && (
        <div className="px-3 pb-3 border-t border-slate-800 pt-2">
          <div className="text-xs text-slate-400 mb-1.5 uppercase tracking-wider">Signal Reasons</div>
          <ul className="space-y-0.5">
            {alert.reasons.map((r, i) => (
              <li key={i} className="text-xs text-slate-300">{r}</li>
            ))}
          </ul>
          {alert.rs_score != null && (
            <div className="mt-2 text-xs text-slate-500">
              RS Score: <span className="text-slate-300">{Number(alert.rs_score).toFixed(1)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BreakoutAlertsPanel({ alerts = [] }) {
  const [search, setSearch] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('impact');

  const filtered = useMemo(() => {
    let list = [...alerts];
    if (search) {
      const q = search.toUpperCase();
      list = list.filter(a =>
        (a.symbol || '').toUpperCase().includes(q) ||
        (a.company_name || '').toUpperCase().includes(q) ||
        (a.sector || '').toUpperCase().includes(q)
      );
    }
    if (urgencyFilter !== 'ALL') {
      list = list.filter(a => a.urgency === urgencyFilter);
    }
    list.sort((a, b) => {
      if (sortBy === 'impact') return (b.impact_score || 0) - (a.impact_score || 0);
      if (sortBy === 'time') return new Date(b.triggered_at) - new Date(a.triggered_at);
      if (sortBy === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
      return 0;
    });
    return list;
  }, [alerts, search, urgencyFilter, sortBy]);

  const counts = useMemo(() => ({
    CRITICAL: alerts.filter(a => a.urgency === 'CRITICAL').length,
    HIGH:     alerts.filter(a => a.urgency === 'HIGH').length,
    MEDIUM:   alerts.filter(a => a.urgency === 'MEDIUM').length,
    LOW:      alerts.filter(a => a.urgency === 'LOW').length,
  }), [alerts]);

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
              Breakout Alerts
            </h3>
            <span className="text-xs bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full font-bold">
              {alerts.length}
            </span>
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="text-xs bg-slate-900 border border-slate-700 text-slate-300 rounded px-2 py-1"
          >
            <option value="impact">Sort: Impact</option>
            <option value="time">Sort: Latest</option>
            <option value="confidence">Sort: Confidence</option>
          </select>
        </div>

        {/* Urgency pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(u => {
            const cfg = URGENCY_CONFIG[u] || {};
            const cnt = u === 'ALL' ? alerts.length : counts[u];
            return (
              <button
                key={u}
                onClick={() => setUrgencyFilter(u)}
                className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                  urgencyFilter === u
                    ? u === 'ALL'
                      ? 'bg-slate-600 text-slate-100 border-slate-500'
                      : `${cfg.bg} ${cfg.text} ${cfg.border}`
                    : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'
                }`}
              >
                {u} {cnt > 0 && <span className="opacity-70">({cnt})</span>}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="mt-2">
          <input
            type="text"
            placeholder="Search symbol, company, sector..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-xs bg-slate-900 border border-slate-700 text-slate-300 rounded px-3 py-1.5 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />
        </div>
      </div>

      {/* Alert list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-500">
            <div className="text-2xl mb-2">📡</div>
            <div className="text-sm">
              {alerts.length === 0
                ? 'Scanning for breakout signals...'
                : 'No alerts match filters'}
            </div>
          </div>
        ) : (
          filtered.map((alert, i) => (
            <AlertCard key={alert.dedup_key || `${alert.symbol}-${i}`} alert={alert} />
          ))
        )}
      </div>
    </div>
  );
}
