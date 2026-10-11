#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-os-test-"));
process.env.NODE_ENV = "test";
process.env.REFLECT_DATA_DIR = path.join(testDir, "data");
process.env.REFLECT_CONFIG_FILE = path.join(testDir, "missing-config.json");

const { handleRequest } = require("../server");

async function run() {
  const server = http.createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(`${base}${route}`, options);

  try {
    let response = await request("/api/health");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    response = await request("/api/assistant/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 401, "assistant credit-spending routes require a signed-in session");

    response = await request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(300 * 1024) });
    assert.equal(response.status, 413, "JSON bodies are size limited");

    response = await request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Mirror Test", email: "mirror@example.test", pin: "1234" }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];

    response = await request("/api/user-data", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ tasks: [{ id: "one", title: "Keep me" }], events: [] }) });
    assert.equal(response.status, 200);

    response = await request("/api/house-layout", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ layout: { floors: 1, rooms: [{ key: "living", label: "Living room", floor: 0, x: [0, 4], z: [0, 4] }], stairs: [] } }) });
    assert.equal(response.status, 200);

    response = await request("/api/user-data", { headers: { Cookie: cookie } });
    assert.equal((await response.json()).tasks[0].title, "Keep me", "account-scoped updates preserve unrelated data");

    const stateFile = path.join(process.env.REFLECT_DATA_DIR, "state.json");
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, "state is private to the device account");
    assert.equal(fs.statSync(process.env.REFLECT_DATA_DIR).mode & 0o777, 0o700, "data directory is private to the device account");
    console.log("Reflect OS smoke tests passed.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
