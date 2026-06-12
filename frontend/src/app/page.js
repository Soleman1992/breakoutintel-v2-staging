"use client";

import { useMarketData } from "../hooks/useMarketData";
import TopBar from "../components/TopBar";
import MarketStatusCard from "../components/MarketStatusCard";
import SectorHeatmap from "../components/SectorHeatmap";
import ScannerTable from "../components/ScannerTable";

export default function Home() {
  const { connected, indices, sectors, scanner, lastUpdate, error } = useMarketData();

  return (
    <main className="bg-slate-950 text-slate-100 min-h-screen">
      {/* Top KPI Bar */}
      <TopBar indices={indices} />

      {/* Header & Status */}
      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-slate-50">BreakoutIntel Terminal</h1>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'
              }`}
            />
            <span className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-red-950 border border-red-700 rounded px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
      </div>

      {/* Dashboard Grid */}
      <div className="p-6 space-y-6">
        {/* Top Row: Market Status & Sector Heatmap */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <MarketStatusCard lastUpdate={lastUpdate} />
          </div>
          <div className="lg:col-span-2">
            <SectorHeatmap sectors={sectors} />
          </div>
        </div>

        {/* Scanner Signals Table */}
        <ScannerTable scanner={scanner} />
      </div>
    </main>
  );
}
