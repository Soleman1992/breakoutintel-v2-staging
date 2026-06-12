"use client";

import { formatPrice, getConfidenceColor } from '../utils/formatters';

function StrategyBadge({ strat }) {
  const strategyLabels = {
    vcp: 'VCP',
    darvas: 'DARVAS',
    vol: 'VOL',
    rs: 'RS',
    tight: 'TIGHT'
  };

  return (
    <span className="text-xs font-bold px-2 py-1 bg-cyan-500/20 text-cyan-300 rounded">
      {strategyLabels[strat] || strat.toUpperCase()}
    </span>
  );
}

function ConfidenceBar({ conf }) {
  const percentage = (conf / 10) * 100;
  const bgColor = getConfidenceColor(conf);

  return (
    <div className="flex items-center gap-2">
      <div className="w-12 bg-slate-700 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full ${bgColor} transition-all`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs font-semibold text-slate-300 w-6">{conf}/10</span>
    </div>
  );
}

export default function ScannerTable({ scanner }) {
  if (!scanner || scanner.length === 0) return null;

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="p-5 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
          Breakout Signals
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-900 border-b border-slate-700">
              <th className="px-4 py-3 text-left font-semibold text-slate-400">#</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Symbol</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Type</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">Entry</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">Stop</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">T1</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">T2</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Conf</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">R:R</th>
            </tr>
          </thead>
          <tbody>
            {scanner.map((signal, idx) => (
              <tr
                key={signal.sym}
                className="border-b border-slate-700 hover:bg-slate-700/50 transition-colors cursor-pointer"
              >
                <td className="px-4 py-3 text-slate-400">{idx + 1}</td>
                <td className="px-4 py-3 font-bold text-slate-100">{signal.sym}</td>
                <td className="px-4 py-3">
                  <StrategyBadge strat={signal.strat} />
                </td>
                <td className="px-4 py-3 text-right text-slate-100 font-mono">
                  {formatPrice(signal.entry)}
                </td>
                <td className="px-4 py-3 text-right text-red-400 font-mono">
                  {formatPrice(signal.stop)}
                </td>
                <td className="px-4 py-3 text-right text-green-400 font-mono">
                  {formatPrice(signal.t1)}
                </td>
                <td className="px-4 py-3 text-right text-green-400 font-mono">
                  {formatPrice(signal.t2)}
                </td>
                <td className="px-4 py-3">
                  <ConfidenceBar conf={signal.conf} />
                </td>
                <td className="px-4 py-3 text-right text-slate-100 font-semibold">
                  {signal.rr?.toFixed(2)}:1
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-5 py-3 bg-slate-900 border-t border-slate-700 text-xs text-slate-400">
        {scanner.length} signal{scanner.length !== 1 ? 's' : ''} available • Updates every 45 seconds
      </div>
    </div>
  );
}
