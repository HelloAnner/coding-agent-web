import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-data-"));
const previous = process.env.PLAN_DATA_DIR;
process.env.PLAN_DATA_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const db = await jiti.import("../db.ts");
const files = await jiti.import("../files.ts");

test.after(() => {
  db.closePlanDb();
  if (previous === undefined) delete process.env.PLAN_DATA_DIR;
  else process.env.PLAN_DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("Plan keeps its complete workspace in its own SQLite database", () => {
  const initial = db.readPlan();
  assert.equal(initial.areas.length, 6);
  assert.ok(initial.goals.length > 0);
  assert.ok(fs.existsSync(path.join(root, "plan.db")));

  const goalId = db.createGoal({
    areaId: "career", title: "Test direction", detail: "A persistent global goal", horizon: "year",
    startDate: "2027-01-01", dueDate: "2027-12-31", status: "active", progress: 10,
  });
  const milestoneId = db.createMilestone(goalId, "First result", "2027-03-01");
  db.setMilestoneDone(milestoneId, true);
  db.savePlanMeta("focus", "One clear direction");
  db.updateGoal(goalId, {
    areaId: "career", title: "Test direction", detail: "Updated", horizon: "year",
    startDate: "2027-01-01", dueDate: "2027-12-31", status: "active", progress: 65,
  });
  db.closePlanDb();

  const saved = db.readPlan();
  assert.equal(saved.goals.find((goal) => goal.id === goalId).progress, 65);
  assert.equal(saved.milestones.find((item) => item.id === milestoneId).done, true);
  assert.equal(saved.meta.focus, "One clear direction");
  db.deleteMilestone(milestoneId);
  db.deleteGoal(goalId);
  assert.equal(db.readPlan().goals.some((goal) => goal.id === goalId), false);
});

test("Plan attachments round-trip through data/plan/files", async () => {
  const goalId = db.readPlan().goals[0].id;
  const form = new FormData();
  form.append("goalId", goalId);
  form.append("file", new File(["plan attachment"], "愿景.txt", { type: "text/plain" }));
  const upload = await files.POST(new Request("http://localhost/api/plan/files", { method: "POST", body: form }));
  assert.equal(upload.status, 200);
  const snapshot = await upload.json();
  const attachment = snapshot.attachments.find((item) => item.goalId === goalId && item.name === "愿景.txt");
  assert.ok(attachment);
  const directory = path.join(root, "files", goalId);
  assert.equal(fs.readdirSync(directory).length, 1);

  const download = await files.GET(new Request(`http://localhost/api/plan/files?id=${attachment.id}`));
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "plan attachment");
  assert.match(download.headers.get("content-disposition"), /attachment/);

  const removed = await files.DELETE(new Request("http://localhost/api/plan/files", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: attachment.id }),
  }));
  assert.equal(removed.status, 200);
  assert.deepEqual(fs.readdirSync(directory), []);
});
