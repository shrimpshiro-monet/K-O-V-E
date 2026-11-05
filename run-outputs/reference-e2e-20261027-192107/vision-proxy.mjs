/**
 * CORS front for the local K.O.V.E analysis engine.
 *
 * The engine (packages/python-engine, uvicorn :8000) only allows origins
 * 5173/3000; the app runs on 5199 and the browser enforces CORS + COEP.
 * This proxy adds permissive CORS on :8001 and forwards everything to :8000,
 * so the agent's VITE_VISION_WORKER_URL can point at a same-machine endpoint
 * without modifying any tracked repo file.
 *
 *   node vision-proxy.mjs          # listens 127.0.0.1:8001 -> 127.0.0.1:8000
 */
import http from "node:http";

const UPSTREAM_PORT = 8000;
const LISTEN_PORT = 8001;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Max-Age": "86400",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...CORS, ...upRes.headers });
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream engine unreachable", detail: String(err) }));
  });
  req.pipe(upstream);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`vision-proxy: 127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});
