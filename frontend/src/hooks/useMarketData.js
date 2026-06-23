/**
 * useMarketData — React hook that connects to the backend WebSocket
 * and provides real-time market data to any component.
 *
 * Usage:
 *   const { indices, scanner, sectors, connected } = useMarketData();
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';

export function useMarketData() {
  const [connected, setConnected] = useState(false);
  const [indices, setIndices] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [scanner, setScanner] = useState([]);
  const [advDec, setAdvDec] = useState(null);
  const [marketStatus, setMarketStatus] = useState('UNKNOWN');
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const [breakoutAlerts, setBreakoutAlerts] = useState([]);
  const [volumeAlerts, setVolumeAlerts] = useState([]);
  const [newsAlerts, setNewsAlerts] = useState([]);

  const ws = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const connectedRef = useRef(false);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;

    try {
      const socket = new WebSocket(`${WS_URL}/ws`);
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
        connectedRef.current = true;
        setError(null);
        reconnectAttempts.current = 0;
        console.log('[WS] Connected to BreakoutIntel data feed');
        // Subscribe to all channels
        socket.send(JSON.stringify({ type: 'subscribe', channels: ['indices','sectors','scanner','alerts'] }));
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          setLastUpdate(new Date());

          switch (msg.type) {
            case 'indices':
              setIndices(msg.data.indices);
              setAdvDec(msg.data.advDec);
              setMarketStatus(msg.data.marketStatus?.marketState || 'UNKNOWN');
              break;
            case 'sectors':
              setSectors(msg.data.sectors || []);
              break;
            case 'scanner':
              setScanner(msg.data.stocks || []);
              break;
            case 'snapshot':
              if (msg.data.indices) setIndices(msg.data.indices);
              if (msg.data.sectors) setSectors(msg.data.sectors);
              break;
            case 'breakout_alerts':
              setBreakoutAlerts(msg.data.alerts || []);
              break;
            case 'volume_alerts':
              setVolumeAlerts(msg.data.alerts || []);
              break;
            case 'news_alerts':
              setNewsAlerts(msg.data.alerts || []);
              break;
            case 'heartbeat':
              break;
          }
        } catch (e) {
          console.error('[WS] Parse error:', e);
        }
      };

      socket.onclose = (event) => {
        setConnected(false);
        connectedRef.current = false;
        console.log(`[WS] Disconnected (code: ${event.code})`);

        // Exponential backoff reconnect (max 30s)
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      socket.onerror = (err) => {
        setError('WebSocket connection failed — using REST API fallback');
        console.error('[WS] Error:', err);
      };
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // REST API fallback when WebSocket is unavailable
  const fetchViaRest = useCallback(async () => {
    try {
      const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const [snapshotRes, scannerRes, boRes, volRes, newsRes] = await Promise.allSettled([
        fetch(`${API}/market/snapshot`).then(r => r.json()),
        fetch(`${API}/scanner/results`).then(r => r.json()),
        fetch(`${API}/alerts/breakout`).then(r => r.json()),
        fetch(`${API}/alerts/volume`).then(r => r.json()),
        fetch(`${API}/alerts/news`).then(r => r.json()),
      ]);

      if (snapshotRes.status === 'fulfilled' && snapshotRes.value.ok) {
        const snap = snapshotRes.value.data;
        if (snap.indices) setIndices(snap.indices);
        if (snap.sectors) setSectors(snap.sectors);
        if (snap.advDec) setAdvDec(snap.advDec);
        setLastUpdate(new Date());
      }
      if (scannerRes.status === 'fulfilled' && scannerRes.value.ok) {
        setScanner(scannerRes.value.data || []);
      }
      if (boRes.status === 'fulfilled' && boRes.value.ok) {
        setBreakoutAlerts(boRes.value.data || []);
      }
      if (volRes.status === 'fulfilled' && volRes.value.ok) {
        setVolumeAlerts(volRes.value.data || []);
      }
      if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
        setNewsAlerts(newsRes.value.data || []);
      }
    } catch (e) {
      console.error('[REST fallback] Error:', e);
    }
  }, []);

  useEffect(() => {
    connect();

    // REST API fallback — polls every 30s if WebSocket disconnects
    const restFallback = setInterval(() => {
      if (!connectedRef.current) fetchViaRest();
    }, 30000);

    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(restFallback);
      ws.current?.close();
    };
  }, [connect, fetchViaRest]);

  return {
    connected,
    indices,
    sectors,
    scanner,
    advDec,
    marketStatus,
    lastUpdate,
    error,
    breakoutAlerts,
    volumeAlerts,
    newsAlerts,
  };
}

// ── Individual quote hook (for stock detail pages) ────────────────────────────
export function useQuote(symbol) {
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!symbol) return;
    const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

    const fetch_ = async () => {
      try {
        const res = await fetch(`${API}/market/quote/${symbol}`);
        const data = await res.json();
        if (data.ok) setQuote(data.data);
        else setError(data.error);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };

    fetch_();
    const interval = setInterval(fetch_, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, [symbol]);

  return { quote, loading, error };
}
