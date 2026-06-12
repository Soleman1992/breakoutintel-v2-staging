"use client";

import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { formatPrice, formatPercent, getChangeColor } from '../utils/formatters';

export default function KPITicker({ name, price, change, data = [] }) {
  if (!price) return null;

  // Transform chartData array into Recharts format
  const chartData = data.map((value, idx) => ({
    idx,
    value: parseFloat(value)
  }));

  const colorClass = getChangeColor(change);

  return (
    <div className="bg-slate-800 rounded-lg p-4 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 cursor-pointer">
      <div className="text-xs text-slate-400 mb-2 uppercase tracking-wider">{name}</div>

      <div className="text-2xl font-bold text-slate-100 mb-1">
        {formatPrice(price)}
      </div>

      <div className={`text-sm font-semibold mb-3 ${colorClass}`}>
        {formatPercent(change)}
      </div>

      {chartData.length > 1 && (
        <div className="h-12 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={change > 0 ? '#10b981' : change < 0 ? '#ef4444' : '#94a3b8'}
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
