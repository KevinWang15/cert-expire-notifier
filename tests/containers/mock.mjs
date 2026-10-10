import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const kind = process.env.MOCK_KIND;
if (!["email", "webhook", "certificate"].includes(kind)) throw new Error("Invalid MOCK_KIND");
const requests = [];
const defaults = () => ({
  status: 200,
  routes: kind === "certificate" ? { "/down": { status: 503 }, "/broken": { status: 503 } } : {},
});
let state = defaults();
let sequence = 0;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req, res) {
  const url = new URL(req.url, "http://mock");
  if (url.pathname === "/__admin/health") return json(res, 200, { kind, ready: true });
  if (url.pathname === "/__admin/requests" && req.method === "GET") {
    return json(res, 200, { kind, requests });
  }
  if (url.pathname === "/__admin/reset" && req.method === "POST") {
    requests.length = 0;
    state = defaults();
    return json(res, 200, { success: true });
  }
  if (url.pathname === "/__admin/state") {
    if (req.method === "PUT") {
      const input = JSON.parse(await readBody(req));
      for (const entry of [input, ...Object.values(input.routes ?? {})]) {
        if (
          entry.status !== undefined &&
          (!Number.isInteger(entry.status) || entry.status < 200 || entry.status > 599)
        ) {
          return json(res, 400, { error: "Status must be between 200 and 599" });
        }
      }
      state = { ...state, ...input, routes: { ...state.routes, ...input.routes } };
    }
    return json(res, 200, { kind, ...state });
  }
  if (url.pathname.startsWith("/__admin/"))
    return json(res, 404, { error: "Unknown admin endpoint" });

  const rawBody = await readBody(req);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = rawBody;
  }
  const record = {
    id: ++sequence,
    receivedAt: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: {
      ...req.headers,
      ...(req.headers.authorization ? { authorization: "(present)" } : {}),
    },
    body,
    rawBody,
    responseStatus: null,
    aborted: false,
  };
  requests.push(record);
  if (requests.length > 5000) requests.shift();
  res.on("close", () => {
    record.aborted = !res.writableEnded;
  });

  let status = state.routes[url.pathname]?.status ?? state.status;
  if (kind === "email") {
    const expectedAuth = `Basic ${Buffer.from("container-email-user:container-email-key").toString("base64")}`;
    if (req.method !== "POST" || url.pathname !== "/v1/mail/send") status = 404;
    else if (req.headers.authorization !== expectedAuth) status = 401;
    else if (!body || !Array.isArray(body.to) || typeof body.body?.content?.html !== "string")
      status = 422;
    record.responseStatus = status;
    return json(res, status, {
      status,
      message: status === 200 ? "Accepted by mock email provider" : "Mock email provider failure",
    });
  }
  if (kind === "webhook") {
    if (url.pathname === "/fail") status = 503;
    if (url.pathname === "/redirect") {
      record.responseStatus = 302;
      res.writeHead(302, { Location: "http://certificate:8080/redirect-target" });
      return res.end();
    }
    if (url.pathname === "/slow") {
      // An actual slow connection exercises the application's ten-second deadline.
      const timer = setTimeout(() => {
        record.responseStatus = 200;
        json(res, 200, { accepted: true });
      }, 30000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    record.responseStatus = status;
    return json(res, status, { accepted: status >= 200 && status < 300 });
  }
  record.responseStatus = status;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(status === 200 ? "Healthy mock website" : `Mock website failure: HTTP ${status}`);
}

const handler = (req, res) => {
  void handle(req, res).catch((error) => {
    console.error(error.message);
    if (!res.headersSent) json(res, 500, { error: error.message });
    else res.destroy();
  });
};
http
  .createServer(handler)
  .listen(8080, "0.0.0.0", () => console.log(`${kind} admin/HTTP service listening on 8080`));
if (kind === "email") {
  https
    .createServer(
      {
        key: readFileSync("/certificates/email-key.pem"),
        cert: readFileSync("/certificates/email.pem"),
      },
      handler,
    )
    .listen(443, "0.0.0.0", () => console.log("Mock EngageLab HTTPS API listening on 443"));
}

if (kind === "certificate") {
  const secondary = process.env.CERTIFICATE_PROFILE === "healthy";
  for (const [port, name] of [
    [8443, secondary ? "healthy" : "expiring"],
    [8444, "healthy"],
    ...(!secondary ? [[8445, "expiring"]] : []),
  ]) {
    https
      .createServer(
        {
          key: readFileSync(`/certificates/${name}-key.pem`),
          cert: readFileSync(`/certificates/${name}.pem`),
        },
        handler,
      )
      .listen(port, "0.0.0.0");
  }
}
