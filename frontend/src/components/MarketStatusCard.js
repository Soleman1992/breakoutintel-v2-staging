"use client";

import { formatTime, getMarketStatus } from '../utils/formatters';

export default function MarketStatusCard({ lastUpdate }) {
  const { isOpen, status, hours } = getMarketStatus();

  const displayTime = lastUpdate ? formatTime(lastUpdate) : '—';
  const nextClose = isOpen ? '15:30 IST' : 'Tomorrow 15:30 IST';

  return (
    <div className="bg-slate-800 rounded-lg p-5 border border-slate-700">
      <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4">
        Market Status
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-slate-400 text-sm">Status</span>
          <span className="text-slate-100 font-semibold">{status}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-slate-400 text-sm">Session</span>
          <span className="text-slate-100 text-sm">Regular Trading Hours</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-slate-400 text-sm">Current Time</span>
          <span className="text-slate-100 font-mono text-sm">{displayTime}</span>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-slate-700">
          <span className="text-slate-400 text-sm">Live Indicator</span>
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isOpen
                  ? 'bg-green-500 animate-pulse'
                  : 'bg-slate-500'
              }`}
            />
            <span className={`text-xs font-semibold ${
              isOpen ? 'text-green-400' : 'text-slate-400'
            }`}>
              {isOpen ? 'LIVE' : 'CLOSED'}
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400 text-sm">Next Close</span>
            <span className="text-slate-100 text-sm">{nextClose}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-slate-400 text-sm">Hours</span>
            <span className="text-slate-100 text-sm">09:15 - 15:30</span>
          </div>
        </div>
      </div>
    </div>
  );
}
