#!/usr/bin/env node
/**
 * 🦀 HermitCrab Gateway — Reverse proxy for multiple bots
 * 
 * Routes incoming requests by path prefix:
 *   /jarvis/*  → Teams bridge (port 3979)
 *   /*         → OpenClaw gateway (port 3978) — default/fallback
 * 
 * Tailscale Funnel → this proxy (port 3980) → correct backend
 */

const http = require("http");

const ROUTES = {
  "/jarvis": { host: "127.0.0.1", port: 3979, strip: true },
  // Default: everything else goes to OpenClaw
  "/": { host: "127.0.0.1", port: 3978, strip: false },
};

const PROXY_PORT = parseInt(process.env.GATEWAY_PORT || "3980", 10);

function findRoute(url) {
  // Check longest prefix first
  for (const [prefix, target] of Object.entries(ROUTES).sort((a, b) => b[0].length - a[0].length)) {
    if (prefix === "/") continue; // Skip default, check last
    if (url.startsWith(prefix)) {
      return { target, prefix };
    }
  }
  return { target: ROUTES["/"], prefix: "" };
}

const server = http.createServer((clientReq, clientRes) => {
  const { target, prefix } = findRoute(clientReq.url);
  
  // Strip prefix if configured (e.g., /jarvis/api/messages → /api/messages)
  const proxyPath = target.strip && prefix
    ? clientReq.url.slice(prefix.length) || "/"
    : clientReq.url;

  const options = {
    hostname: target.host,
    port: target.port,
    path: proxyPath,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: `${target.host}:${target.port}`,
    },
  };

  const routeName = prefix || "openclaw";
  console.log(`[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} → :${target.port}${proxyPath} (${routeName})`);

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Proxy error → :${target.port}: ${err.message}`);
    clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "Backend unavailable", target: `${target.host}:${target.port}` }));
  });

  clientReq.pipe(proxyReq, { end: true });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🦀 HermitCrab Gateway — Reverse Proxy               ║
║                                                      ║
║  Listening: http://0.0.0.0:${PROXY_PORT}                  ║
║                                                      ║
║  Routes:                                             ║
║    /jarvis/*  → localhost:3979 (JARVIS Teams bridge)  ║
║    /*         → localhost:3978 (OpenClaw gateway)     ║
║                                                      ║
║  Tailscale Funnel → :${PROXY_PORT} → correct backend      ║
╚══════════════════════════════════════════════════════╝
  `);
});
