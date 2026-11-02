"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PlanGoal, PlanGoalInput, PlanHorizon, PlanSnapshot, PlanStatus } from "../types";
import { Icon } from "./Icons";
import styles from "./plan.module.css";

const horizonLabels: Record<PlanHorizon, string> = { quarter: "未来 90 天", year: "今年", future: "未来 1–3 年" };
const statusLabels: Record<PlanStatus, string> = { active: "进行中", paused: "已暂停", done: "已完成" };

function dateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function GoalDialog({
  goal,
  plan,
  onClose,
  onMutate,
  onUpload,
  onDeleteAttachment,
}: {
  goal: PlanGoal | null;
  plan: PlanSnapshot;
  onClose: () => void;
  onMutate: (body: Record<string, unknown>) => Promise<void>;
  onUpload: (goalId: string, file: File) => Promise<void>;
  onDeleteAttachment: (id: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<PlanGoalInput>(() => goal ? {
    areaId: goal.areaId, title: goal.title, detail: goal.detail, horizon: goal.horizon,
    startDate: goal.startDate, dueDate: goal.dueDate, status: goal.status, progress: goal.progress,
  } : {
    areaId: plan.areas[0]?.id ?? "", title: "", detail: "", horizon: "quarter",
    startDate: dateAfter(0), dueDate: dateAfter(90), status: "active", progress: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDate, setMilestoneDate] = useState("");
  const milestones = goal ? plan.milestones.filter((item) => item.goalId === goal.id) : [];
  const attachments = goal ? plan.attachments.filter((item) => item.goalId === goal.id) : [];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.areaId) return;
    await run(async () => {
      await onMutate({ action: goal ? "updateGoal" : "createGoal", ...(goal ? { id: goal.id } : {}), ...form });
      onClose();
    });
  };

  const addMilestone = () => {
    if (!goal || !milestoneTitle.trim()) return;
    void run(async () => {
      await onMutate({ action: "createMilestone", goalId: goal.id, title: milestoneTitle, dueDate: milestoneDate });
      setMilestoneTitle("");
      setMilestoneDate("");
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="plan-goal-dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <form className={styles.dialogSurface} onSubmit={save}>
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>{goal ? "目标详情" : "新的全局目标"}</span>
            <h2 id="plan-goal-dialog-title">{goal ? "把目标推进到下一步" : "现在，什么最值得投入？"}</h2>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className={styles.dialogBody}>
          <label className={styles.fieldFull}>
            <span>目标名称</span>
            <input autoFocus={!goal} value={form.title} maxLength={160} placeholder="例如：完成独立产品的核心价值验证" onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          <div className={styles.formGrid}>
            <label><span>人生领域</span><select value={form.areaId} onChange={(event) => setForm({ ...form, areaId: event.target.value })}>{plan.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
            <label><span>时间范围</span><select value={form.horizon} onChange={(event) => setForm({ ...form, horizon: event.target.value as PlanHorizon })}>{Object.entries(horizonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>开始日期</span><input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} /></label>
            <label><span>目标日期</span><input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label>
            <label><span>状态</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as PlanStatus })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className={styles.progressField}><span>完成度 <strong>{form.progress}%</strong></span><input type="range" min="0" max="100" step="5" value={form.progress} style={{ "--range-progress": `${form.progress}%` } as React.CSSProperties} onChange={(event) => setForm({ ...form, progress: Number(event.target.value) })} /></label>
          </div>
          <label className={styles.fieldFull}>
            <span>为什么重要 / 成功标准</span>
            <textarea rows={3} value={form.detail} maxLength={5000} placeholder="写清楚它与你的人生方向有什么关系，以及怎样才算完成。" onChange={(event) => setForm({ ...form, detail: event.target.value })} />
          </label>

          {goal && (
            <>
              <section className={styles.detailSection}>
                <div className={styles.detailHeading}><div><Icon name="flag" size={16} /><h3>关键里程碑</h3></div><span>{milestones.filter((item) => item.done).length}/{milestones.length}</span></div>
                <div className={styles.milestoneList}>
                  {milestones.map((milestone) => (
                    <div className={styles.milestoneEdit} key={milestone.id}>
                      <button type="button" className={`${styles.checkButton} ${milestone.done ? styles.checked : ""}`} aria-label={milestone.done ? `标记 ${milestone.title} 为未完成` : `完成 ${milestone.title}`} disabled={busy} onClick={() => void run(() => onMutate({ action: "setMilestoneDone", id: milestone.id, done: !milestone.done }))}><Icon name="check" size={13} /></button>
                      <div><strong className={milestone.done ? styles.completedText : ""}>{milestone.title}</strong><span>{milestone.dueDate || "未设日期"}</span></div>
                      <button type="button" className={styles.subtleIcon} aria-label={`删除里程碑 ${milestone.title}`} disabled={busy} onClick={() => void run(() => onMutate({ action: "deleteMilestone", id: milestone.id }))}><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                  {milestones.length === 0 && <p className={styles.emptyHint}>把大目标拆成几个可以验证的结果。</p>}
                </div>
                <div className={styles.milestoneAdd}>
                  <input aria-label="新里程碑名称" placeholder="添加一个里程碑…" value={milestoneTitle} maxLength={200} onChange={(event) => setMilestoneTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMilestone(); } }} />
                  <input aria-label="新里程碑日期" type="date" value={milestoneDate} onChange={(event) => setMilestoneDate(event.target.value)} />
                  <button type="button" className={styles.secondaryButton} disabled={busy || !milestoneTitle.trim()} onClick={addMilestone}><Icon name="plus" size={15} />添加</button>
                </div>
              </section>

              <section className={styles.detailSection}>
                <div className={styles.detailHeading}><div><Icon name="paperclip" size={16} /><h3>相关资料</h3></div><span>{attachments.length} 个文件</span></div>
                <div className={styles.attachmentList}>
                  {attachments.map((attachment) => (
                    <div className={styles.attachment} key={attachment.id}>
                      <span className={styles.fileIcon}><Icon name="file" size={16} /></span>
                      <a href={`/api/plan/files?id=${encodeURIComponent(attachment.id)}`} download={attachment.name}><strong>{attachment.name}</strong><span>{fileSize(attachment.size)}</span></a>
                      <button type="button" className={styles.subtleIcon} aria-label={`删除附件 ${attachment.name}`} disabled={busy} onClick={() => { if (window.confirm(`删除附件“${attachment.name}”？`)) void run(() => onDeleteAttachment(attachment.id)); }}><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                  {attachments.length === 0 && <p className={styles.emptyHint}>愿景文档、参考材料或复盘文件都可以放在这里。</p>}
                </div>
                <label className={`${styles.uploadButton} ${busy ? styles.disabled : ""}`}>
                  <Icon name="upload" size={15} />上传附件 <span>单个不超过 20 MB</span>
                  <input type="file" disabled={busy} onChange={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    if (file) void run(() => onUpload(goal.id, file)).finally(() => { input.value = ""; });
                  }} />
                </label>
              </section>
            </>
          )}
          {error && <p className={styles.formError} role="alert">{error}</p>}
        </div>

        <footer className={styles.dialogFooter}>
          {goal ? <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => { if (window.confirm(`删除目标“${goal.title}”及其里程碑、附件？`)) void run(async () => { await onMutate({ action: "deleteGoal", id: goal.id }); onClose(); }); }}><Icon name="trash" size={15} />删除目标</button> : <span />}
          <div><button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button><button type="submit" className={styles.primaryButton} disabled={busy || !form.title.trim() || !form.areaId}>{busy ? "保存中…" : goal ? "保存更改" : "创建目标"}</button></div>
        </footer>
      </form>
    </dialog>
  );
}
