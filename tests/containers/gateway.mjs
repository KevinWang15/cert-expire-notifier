import http from "node:http";

// Publish inspection ports without giving the app or mocks an external route.
const upstreams = new Map([
  [3000, "http://app:3000"],
  [8081, "http://webhook:8080"],
  [8082, "http://email:8080"],
  [8083, "http://certificate:8080"],
]);
for (const [port, base] of upstreams) {
  http
    .createServer((req, res) => {
      const incoming = new URL(req.url, "http://gateway");
      const target = new URL(base);
      target.pathname = incoming.pathname;
      target.search = incoming.search;
      const upstream = http.request(
        target,
        {
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Container upstream unavailable" }));
        } else res.destroy();
      });
      req.on("error", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    })
    .listen(port, "0.0.0.0", () => console.log(`Inspection gateway ${port} -> ${base}`));
}
