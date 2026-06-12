/**
 * Number & price formatting utilities
 */

export const formatPrice = (price) => {
  if (price === null || price === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
};

export const formatPercent = (pct) => {
  if (pct === null || pct === undefined) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${(pct).toFixed(2)}%`;
};

export const formatChange = (change, pct) => {
  if (change === null || pct === null) return '—';
  const sign = change > 0 ? '+' : '';
  return `${sign}${formatPrice(change)} (${formatPercent(pct)})`;
};

export const formatLargeNumber = (num) => {
  if (num === null || num === undefined) return '—';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toFixed(0);
};

export const getChangeColor = (pct) => {
  if (pct === null || pct === undefined) return 'text-slate-400';
  if (pct > 0) return 'text-green-500';
  if (pct < 0) return 'text-red-500';
  return 'text-slate-400';
};

export const getConfidenceColor = (conf) => {
  if (conf >= 8) return 'bg-green-500';
  if (conf >= 5) return 'bg-yellow-500';
  return 'bg-red-500';
};

export const formatTime = (timestamp) => {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

export const isMarketOpen = () => {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hour = istTime.getHours();
  const min = istTime.getMinutes();
  const timeInMinutes = hour * 60 + min;

  // Market open: 09:15 - 15:30
  return timeInMinutes >= 9 * 60 + 15 && timeInMinutes < 15 * 60 + 30;
};

export const getMarketStatus = () => {
  const open = isMarketOpen();
  return {
    isOpen: open,
    status: open ? 'OPEN' : 'CLOSED',
    hours: '09:15 - 15:30 IST',
  };
};
