"use client";

import { formatPercent, formatPrice, getChangeColor } from '../utils/formatters';

function SectorCell({ name, changePct, price }) {
  const colorClass = getChangeColor(changePct);

  return (
    <div className="bg-slate-800 rounded-lg p-4 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
      <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
        {name}
      </div>

      <div className="text-lg font-bold text-slate-100 mb-1">
        {formatPrice(price)}
      </div>

      <div className={`text-sm font-semibold ${colorClass}`}>
        {formatPercent(changePct)}
      </div>
    </div>
  );
}

export default function SectorHeatmap({ sectors }) {
  if (!sectors || sectors.length === 0) return null;

  // Filter only working sectors
  const workingSectors = sectors.filter(s => s.ok === true);

  return (
    <div className="bg-slate-800 rounded-lg p-5 border border-slate-700">
      <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4">
        Sector Strength
      </h3>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {workingSectors.map(sector => (
          <SectorCell
            key={sector.name}
            name={sector.name}
            changePct={sector.changePct}
            price={sector.price}
          />
        ))}
      </div>

      {workingSectors.length < sectors.length && (
        <div className="mt-3 pt-3 border-t border-slate-700">
          <p className="text-xs text-slate-500">
            {sectors.length - workingSectors.length} sector{sectors.length - workingSectors.length !== 1 ? 's' : ''} excluded (no data)
          </p>
        </div>
      )}
    </div>
  );
}
