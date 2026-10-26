import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { dshKernel } = await createJiti(import.meta.url).import("./acp.ts");

test("ACP errors retain the detail behind Invalid params without starting a kernel", async () => {
  const client = dshKernel();
  for (const data of ["session is not resumable", { reason: "unknown session" }, undefined]) {
    const response = new Promise((resolve, reject) => client.pending.set(123, { resolve, reject }));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 123, error: { code: -32602, message: "Invalid params", data } }));
    await assert.rejects(response, (error) => {
      assert.match(error.message, /Invalid params/);
      if (data !== undefined) assert.ok(error.message.includes(typeof data === "string" ? data : JSON.stringify(data)));
      return true;
    });
  }
  assert.equal(client.isRunning(), false);
  assert.equal(client.pending.size, 0);
});
