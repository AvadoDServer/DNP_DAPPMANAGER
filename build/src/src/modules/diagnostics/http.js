/* global fetch, AbortSignal */
/**
 * Small HTTP helpers on Node's fetch, each with its own timeout. Kept in one
 * module so tests can replace them.
 */

async function request(url, { method = "GET", body, headers, timeout = 4000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: Object.assign(body !== undefined ? { "Content-Type": "application/json" } : {}, headers || {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
    redirect: "follow"
  });
  return res;
}

/** GET a JSON document; non-2xx is an error */
async function getJson(url, timeout = 4000) {
  const res = await request(url, { timeout });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  return res.json();
}

/** A JSON-RPC call; its error member is an error */
async function jsonRpc(url, method, rpcParams = [], timeout = 4000) {
  const res = await request(url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params: rpcParams },
    timeout
  });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw Error(data.error.message || "JSON-RPC error");
  return data ? data.result : undefined;
}

/** HEAD a URL: any HTTP answer proves the connection; returns the status */
async function head(url, timeout = 5000) {
  const res = await request(url, { method: "HEAD", timeout });
  return res.status;
}

module.exports = { getJson, jsonRpc, head };
