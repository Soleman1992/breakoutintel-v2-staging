"use client";

import { useState, useMemo } from 'react';
import { formatTime, formatLargeNumber } from '../utils/formatters';

const TIER_CONFIG = {
  EXTREME:  { bg: 'bg-purple-500/20', text: 'text-purple-300', border: 'border-purple-500/40', bar: 'bg-purple-500' },
  HIGH:     { bg: 'bg-orange-500/20', text: 'text-orange-300', border: 'border-orange-500/40', bar: 'bg-orange-500' },
  ELEVATED: { bg: 'bg-yellow-500/20', text: 'text-yellow-300', border: 'border-yellow-500/40', bar: 'bg-yellow-500' },
};

const URGENCY_CONFIG = {
  CRITICAL: { text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' },
  HIGH:     { text: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  MEDIUM:   { text: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30' },
  LOW:      { text: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-700' },
};

function VolMultiple({ ratio }) {
  const r = Number(ratio) || 0;
  const cfg = r >= 5 ? TIER_CONFIG.EXTREME : r >= 4 ? TIER_CONFIG.HIGH : TIER_CONFIG.ELEVATED;
  const pct = Math.min(100, (r / 10) * 100);
  return (
    <div className="flex flex-col items-center gap-1 min-w-[56px]">
      <div className={`text-lg font-black font-mono ${cfg.text}`}>{r.toFixed(1)}x</div>
      <div className="w-full bg-slate-700 rounded-full h-1">
        <div className={`h-1 rounded-full ${cfg.bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TierBadge({ tier }) {
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.ELEVATED;
  return (
    <span className={`text-[10px] font-black px-2 py-0.5 rounded border ${cfg.bg} ${cfg.text} ${cfg.border} tracking-widest`}>
      {tier}
    </span>
  );
}

function VolumeCard({ alert }) {
  const [expanded, setExpanded] = useState(false);
  const tier = (alert.urgency === 'CRITICAL' || Number(alert.vol_ratio) >= 5) ? 'EXTREME'
             : Number(alert.vol_ratio) >= 4 ? 'HIGH' : 'ELEVATED';
  const urgCfg = URGENCY_CONFIG[alert.urgency] || URGENCY_CONFIG.LOW;

  return (
    <div
      className={`border rounded-lg transition-all cursor-pointer ${urgCfg.border} ${urgCfg.bg} hover:border-slate-600`}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="p-3 flex items-start gap-3">
        {/* Vol multiple */}
        <VolMultiple ratio={alert.vol_ratio} />

        {/* Symbol info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-100 text-sm">
              {(alert.symbol || '').replace('.NS', '')}
            </span>
            <TierBadge tier={tier} />
          </div>
          <div className="text-xs text-slate-400 truncate mt-0.5">
            {alert.company_name || ''}
          </div>
          {/* Current vs Avg */}
          <div className="flex items-center gap-3 mt-1.5">
            <div>
              <span className="text-[10px] text-slate-500 uppercase">Now </span>
              <span className="text-xs font-mono text-slate-200">{formatLargeNumber(alert.cur_volume)}</span>
            </div>
            <span className="text-slate-600">vs</span>
            <div>
              <span className="text-[10px] text-slate-500 uppercase">Avg </span>
              <span className="text-xs font-mono text-slate-400">{formatLargeNumber(alert.avg_volume)}</span>
            </div>
          </div>
        </div>

        {/* Right column: impact + meta */}
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500">Impact</span>
            <span className={`text-xs font-bold ${urgCfg.text}`}>{alert.impact_score}</span>
          </div>
          {alert.sector && (
            <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
              {alert.sector}
            </span>
          )}
          <span className="text-[10px] text-slate-600">{formatTime(alert.triggered_at)}</span>
        </div>
      </div>

      {/* Reasons */}
      {expanded && alert.reasons && alert.reasons.length > 0 && (
        <div className="px-3 pb-3 border-t border-slate-800 pt-2">
          <ul className="space-y-0.5">
            {alert.reasons.map((r, i) => (
              <li key={i} className="text-xs text-slate-300">{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function VolumeAlertsPanel({ alerts = [] }) {
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('vol');

  const categorised = useMemo(() => alerts.map(a => ({
    ...a,
    _tier: (Number(a.vol_ratio) >= 5 || a.urgency === 'CRITICAL') ? 'EXTREME'
          : Number(a.vol_ratio) >= 4 ? 'HIGH' : 'ELEVATED',
  })), [alerts]);

  const filtered = useMemo(() => {
    let list = [...categorised];
    if (search) {
      const q = search.toUpperCase();
      list = list.filter(a =>
        (a.symbol || '').toUpperCase().includes(q) ||
        (a.company_name || '').toUpperCase().includes(q) ||
        (a.sector || '').toUpperCase().includes(q)
      );
    }
    if (tierFilter !== 'ALL') {
      list = list.filter(a => a._tier === tierFilter);
    }
    list.sort((a, b) => {
      if (sortBy === 'vol')    return (Number(b.vol_ratio) || 0) - (Number(a.vol_ratio) || 0);
      if (sortBy === 'impact') return (b.impact_score || 0) - (a.impact_score || 0);
      if (sortBy === 'time')   return new Date(b.triggered_at) - new Date(a.triggered_at);
      return 0;
    });
    return list;
  }, [categorised, search, tierFilter, sortBy]);

  const counts = useMemo(() => ({
    EXTREME:  categorised.filter(a => a._tier === 'EXTREME').length,
    HIGH:     categorised.filter(a => a._tier === 'HIGH').length,
    ELEVATED: categorised.filter(a => a._tier === 'ELEVATED').length,
  }), [categorised]);

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
              Volume Alerts
            </h3>
            <span className="text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 px-2 py-0.5 rounded-full font-bold">
              {alerts.length}
            </span>
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="text-xs bg-slate-900 border border-slate-700 text-slate-300 rounded px-2 py-1"
          >
            <option value="vol">Sort: Volume</option>
            <option value="impact">Sort: Impact</option>
            <option value="time">Sort: Latest</option>
          </select>
        </div>

        {/* Tier filters */}
        <div className="flex items-center gap-1.5">
          {['ALL', 'EXTREME', 'HIGH', 'ELEVATED'].map(t => {
            const cfg = TIER_CONFIG[t] || {};
            const cnt = t === 'ALL' ? alerts.length : counts[t];
            return (
              <button
                key={t}
                onClick={() => setTierFilter(t)}
                className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                  tierFilter === t
                    ? t === 'ALL'
                      ? 'bg-slate-600 text-slate-100 border-slate-500'
                      : `${cfg.bg} ${cfg.text} ${cfg.border}`
                    : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'
                }`}
              >
                {t} {cnt > 0 && <span className="opacity-70">({cnt})</span>}
              </button>
            );
          })}
        </div>

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
            <div className="text-2xl mb-2">📊</div>
            <div className="text-sm">
              {alerts.length === 0
                ? 'Monitoring volume activity...'
                : 'No alerts match filters'}
            </div>
          </div>
        ) : (
          filtered.map((alert, i) => (
            <VolumeCard key={alert.dedup_key || `${alert.symbol}-${i}`} alert={alert} />
          ))
        )}
      </div>
    </div>
  );
}
