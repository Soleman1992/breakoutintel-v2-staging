"use client";

import { useMarketData } from "../hooks/useMarketData";

export default function Home() {
  const {
    connected,
    indices,
    sectors,
    scanner,
    marketStatus,
    error,
  } = useMarketData();

  return (
    <main style={{
      background:"#0f172a",
      color:"white",
      minHeight:"100vh",
      padding:"20px",
      fontFamily:"Arial"
    }}>
      <h1>BreakoutIntel Terminal</h1>

      <div style={{
        marginBottom:"20px",
        padding:"10px",
        background:"#1e293b",
        borderRadius:"8px"
      }}>
        <strong>Status:</strong>{" "}
        {connected ? "🟢 Connected" : "🔴 Disconnected"}
      </div>

      {error && (
        <div style={{
          background:"#7f1d1d",
          padding:"10px",
          marginBottom:"20px"
        }}>
          {error}
        </div>
      )}

      <h2>Market Status</h2>
      <p>{marketStatus}</p>

      <hr />

      <h2>Indices</h2>

      <pre>
        {JSON.stringify(indices, null, 2)}
      </pre>

      <hr />

      <h2>Sectors</h2>

      <pre>
        {JSON.stringify(sectors, null, 2)}
      </pre>

      <hr />

      <h2>Scanner Results</h2>

      <pre>
        {JSON.stringify(scanner, null, 2)}
      </pre>
    </main>
  );
}
