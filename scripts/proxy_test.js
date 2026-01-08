#!/usr/bin/env node
"use strict";

const { request, ProxyAgent } = require("undici");

function parseArgs(argv) {
  const args = {
    scheme: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    password: "",
    url: "https://api.myip.com",
    timeout: 10000
  };

  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }

  args.port = Number(args.port);
  args.timeout = Number(args.timeout);
  return args;
}

function buildProxyUrl({ scheme, host, port, username, password }) {
  const auth = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return `${scheme}://${auth}${host}:${port}`;
}

function buildDispatcher(proxyUrl) {
  if (proxyUrl.startsWith("socks")) {
    throw new Error("SOCKS proxies are not supported by this Node.js tester. Use HTTP/HTTPS proxies.");
  }
  return new ProxyAgent(proxyUrl);
}

async function requestJson(targetUrl, dispatcher, timeoutMs) {
  const response = await request(targetUrl, {
    dispatcher,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    headers: {
      "User-Agent": "proxy-test/1.0"
    }
  });

  const body = await response.body.text();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Request failed (${response.statusCode}): ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Invalid JSON response");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const proxyUrl = buildProxyUrl(args);
  const dispatcher = buildDispatcher(proxyUrl);
  const started = Date.now();

  try {
    const data = await requestJson(args.url, dispatcher, args.timeout);
    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ ok: true, elapsedMs, ip: data.ip, country: data.country, cc: data.cc }, null, 2));
  } catch (error) {
    const elapsedMs = Date.now() - started;
    console.error(JSON.stringify({ ok: false, elapsedMs, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
