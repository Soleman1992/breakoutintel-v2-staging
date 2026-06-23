"use client";

import { useState, useMemo } from 'react';

const SENTIMENT_CONFIG = {
  Bullish:  { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/40' },
  Bearish:  { bg: 'bg-red-500/20',   text: 'text-red-400',   border: 'border-red-500/40' },
  Neutral:  { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/40' },
};

const URGENCY_CONFIG = {
  CRITICAL:   { bg: 'bg-red-500/20',    text: 'text-red-400',    border: 'border-red-500/40',    dot: 'bg-red-500' },
  HIGH:       { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/40', dot: 'bg-orange-500' },
  MEDIUM:     { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/40', dot: 'bg-yellow-500' },
  LOW:        { bg: 'bg-slate-500/20',  text: 'text-slate-400',  border: 'border-slate-500/40',  dot: 'bg-slate-500' },
  Immediate:  { bg: 'bg-red-500/20',    text: 'text-red-400',    border: 'border-red-500/40',    dot: 'bg-red-500' },
  'Short-Term': { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/40', dot: 'bg-orange-500' },
};

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ImpactBadge({ score }) {
  const s = Math.min(100, Math.max(0, score || 0));
  const color = s >= 85 ? 'text-red-400 bg-red-500/10 border-red-500/30'
              : s >= 70 ? 'text-orange-400 bg-orange-500/10 border-orange-500/30'
              : s >= 50 ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
              : 'text-slate-400 bg-slate-500/10 border-slate-700';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${color}`}>
      {s}
    </span>
  );
}

function SentimentBadge({ sentiment }) {
  const cfg = SENTIMENT_CONFIG[sentiment] || SENTIMENT_CONFIG.Neutral;
  const arrow = sentiment === 'Bullish' ? '▲' : sentiment === 'Bearish' ? '▼' : '◆';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      {arrow} {sentiment?.toUpperCase() || 'NEUTRAL'}
    </span>
  );
}

function UrgencyChip({ urgency }) {
  const cfg = URGENCY_CONFIG[urgency] || URGENCY_CONFIG.LOW;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <span className={`w-1 h-1 rounded-full ${cfg.dot}`} />
      {urgency}
    </span>
  );
}

function NewsCard({ item }) {
  const [expanded, setExpanded] = useState(false);
  const affectedStocks = Array.isArray(item.affected_stocks)
    ? item.affected_stocks
    : (item.affected_stocks ? String(item.affected_stocks).split(',').map(s => s.trim()).filter(Boolean) : []);
  const affectedSectors = Array.isArray(item.affected_sectors)
    ? item.affected_sectors
    : (item.affected_sectors ? String(item.affected_sectors).split(',').map(s => s.trim()).filter(Boolean) : []);

  return (
    <div
      className="border border-slate-700 rounded-lg bg-slate-900 hover:border-slate-600 transition-all cursor-pointer"
      onClick={() => setExpanded(e => !e)}
    >
      <div className="p-3">
        {/* Header row */}
        <div className="flex items-start gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-100 font-medium leading-snug line-clamp-2">
              {item.title || item.headline || 'Untitled'}
            </p>
          </div>
          <div className="flex-shrink-0 flex flex-col items-end gap-1">
            <ImpactBadge score={item.impact_score} />
          </div>
        </div>

        {/* Badges row */}
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          <SentimentBadge sentiment={item.sentiment} />
          <UrgencyChip urgency={item.urgency || item.ai_urgency} />
          {item.category && (
            <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
              {item.category}
            </span>
          )}
        </div>

        {/* Source + time */}
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>{item.source || item.feed_source || 'Market Intelligence'}</span>
          <span>{timeAgo(item.published_at || item.triggered_at)}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-800 px-3 pb-3 pt-2 space-y-2">
          {item.why_it_matters && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Why It Matters</div>
              <p className="text-xs text-slate-300 leading-relaxed">{item.why_it_matters}</p>
            </div>
          )}
          {item.trading_implication && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Trading Implication</div>
              <p className="text-xs text-slate-300 leading-relaxed">{item.trading_implication}</p>
            </div>
          )}
          {affectedStocks.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Affected Stocks</div>
              <div className="flex flex-wrap gap-1">
                {affectedStocks.slice(0, 10).map((s, i) => (
                  <span key={i} className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 rounded">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          {affectedSectors.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Affected Sectors</div>
              <div className="flex flex-wrap gap-1">
                {affectedSectors.map((s, i) => (
                  <span key={i} className="text-[10px] text-slate-400 bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 text-[10px] text-slate-600">
            {item.confidence != null && <span>AI Confidence: {item.confidence}%</span>}
            {item.trading_relevance != null && <span>Relevance: {item.trading_relevance}%</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function NewsIntelligencePanel({ alerts = [] }) {
  const [search, setSearch] = useState('');
  const [sentimentFilter, setSentimentFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('impact');

  const filtered = useMemo(() => {
    let list = [...alerts];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        (a.title || a.headline || '').toLowerCase().includes(q) ||
        (a.category || '').toLowerCase().includes(q) ||
        (a.source || a.feed_source || '').toLowerCase().includes(q)
      );
    }
    if (sentimentFilter !== 'ALL') {
      list = list.filter(a => a.sentiment === sentimentFilter);
    }
    list.sort((a, b) => {
      if (sortBy === 'impact') return (b.impact_score || 0) - (a.impact_score || 0);
      if (sortBy === 'time')   return new Date(b.published_at || b.triggered_at) - new Date(a.published_at || a.triggered_at);
      return 0;
    });
    return list;
  }, [alerts, search, sentimentFilter, sortBy]);

  const counts = useMemo(() => ({
    Bullish: alerts.filter(a => a.sentiment === 'Bullish').length,
    Bearish: alerts.filter(a => a.sentiment === 'Bearish').length,
    Neutral: alerts.filter(a => a.sentiment === 'Neutral').length,
  }), [alerts]);

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
              News Intelligence
            </h3>
            <span className="text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full font-bold">
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
          </select>
        </div>

        {/* Sentiment filters */}
        <div className="flex items-center gap-1.5">
          {[
            { key: 'ALL', label: 'All', cnt: alerts.length },
            { key: 'Bullish', label: '▲ Bullish', cnt: counts.Bullish },
            { key: 'Bearish', label: '▼ Bearish', cnt: counts.Bearish },
            { key: 'Neutral', label: '◆ Neutral', cnt: counts.Neutral },
          ].map(({ key, label, cnt }) => {
            const cfg = SENTIMENT_CONFIG[key] || {};
            return (
              <button
                key={key}
                onClick={() => setSentimentFilter(key)}
                className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                  sentimentFilter === key
                    ? key === 'ALL'
                      ? 'bg-slate-600 text-slate-100 border-slate-500'
                      : `${cfg.bg} ${cfg.text} ${cfg.border}`
                    : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'
                }`}
              >
                {label} {cnt > 0 && <span className="opacity-70">({cnt})</span>}
              </button>
            );
          })}
        </div>

        <div className="mt-2">
          <input
            type="text"
            placeholder="Search headline, category, source..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-xs bg-slate-900 border border-slate-700 text-slate-300 rounded px-3 py-1.5 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />
        </div>
      </div>

      {/* News list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-500">
            <div className="text-2xl mb-2">📰</div>
            <div className="text-sm">
              {alerts.length === 0
                ? 'Fetching market intelligence...'
                : 'No news matches filters'}
            </div>
          </div>
        ) : (
          filtered.map((item, i) => (
            <NewsCard key={item.id || item.content_hash || `news-${i}`} item={item} />
          ))
        )}
      </div>
    </div>
  );
}
