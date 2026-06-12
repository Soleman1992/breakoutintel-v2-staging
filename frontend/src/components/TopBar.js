"use client";

import KPITicker from './KPITicker';

const SAFE_INDICES = ['NIFTY50', 'BANKNIFTY', 'MIDCAP150', 'SENSEX', 'INDIAVIX'];

export default function TopBar({ indices }) {
  if (!indices) return null;

  return (
    <div className="bg-slate-900 border-b border-slate-700 px-6 py-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {SAFE_INDICES.map(indexKey => {
          const indexData = indices[indexKey];

          if (!indexData || indexData.ok === false) return null;

          return (
            <KPITicker
              key={indexKey}
              name={indexData.name}
              price={indexData.price}
              change={indexData.changePct}
              data={indexData.chartData}
            />
          );
        })}
      </div>
    </div>
  );
}
