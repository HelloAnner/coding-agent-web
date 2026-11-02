"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { GoalDialog } from "./GoalDialog";
import { Icon, type IconName } from "./Icons";
import styles from "./plan.module.css";
import type { PlanArea, PlanGoal, PlanHorizon, PlanSnapshot, PlanStatus } from "../types";

type View = "overview" | "blueprint" | "goals";
type SaveState = "saved" | "saving" | "error";

const viewLabels: Record<View, string> = { overview: "全局总览", blueprint: "人生蓝图", goals: "目标清单" };
const horizonLabels: Record<PlanHorizon, string> = { quarter: "未来 90 天", year: "今年", future: "未来 1–3 年" };
const statusLabels: Record<PlanStatus, string> = { active: "进行中", paused: "已暂停", done: "已完成" };

function areaIcon(id: string): IconName {
  return ({ career: "briefcase", growth: "book", health: "heart", wealth: "wallet", relationships: "users", life: "sun" } as Record<string, IconName>)[id] ?? "spark";
}

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function formatDate(value: string): string {
  if (!value) return "未设日期";
  const [, month, day] = value.split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function goalProgress(goals: PlanGoal[]): number {
  return average(goals.map((goal) => goal.progress));
}

async function responsePlan(response: Response): Promise<PlanSnapshot> {
  const body = await response.json() as PlanSnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error || "操作失败，请稍后重试");
  return body;
}

export function PlanApp() {
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [areaFilter, setAreaFilter] = useState("all");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await responsePlan(await fetch("/api/plan", { cache: "no-store" }));
      setPlan(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取规划失败");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = useCallback(async (body: Record<string, unknown>) => {
    const next = await responsePlan(await fetch("/api/plan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    setPlan(next);
    setError("");
  }, []);

  const saveBlueprint = useCallback(async (body: Record<string, unknown>) => {
    setSaveState("saving");
    try { await mutate(body); setSaveState("saved"); }
    catch (cause) { setSaveState("error"); throw cause; }
  }, [mutate]);

  const upload = useCallback(async (goalId: string, file: File) => {
    const form = new FormData();
    form.append("goalId", goalId);
    form.append("file", file);
    const next = await responsePlan(await fetch("/api/plan/files", { method: "POST", body: form }));
    setPlan(next);
  }, []);

  const removeAttachment = useCallback(async (id: string) => {
    const next = await responsePlan(await fetch("/api/plan/files", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }));
    setPlan(next);
  }, []);

  const visibleGoals = useMemo(() => {
    if (!plan) return [];
    const needle = query.trim().toLowerCase();
    return plan.goals.filter((goal) => {
      if (areaFilter !== "all" && goal.areaId !== areaFilter) return false;
      if (!needle) return true;
      const area = plan.areas.find((item) => item.id === goal.areaId);
      return `${goal.title} ${goal.detail} ${area?.name ?? ""}`.toLowerCase().includes(needle);
    });
  }, [areaFilter, plan, query]);

  const selectView = (next: View) => {
    setView(next);
    setSidebarOpen(false);
    if (next !== "goals" && next !== "overview") setAreaFilter("all");
  };

  const selectedGoal = selected && selected !== "new" ? plan?.goals.find((goal) => goal.id === selected) ?? null : null;

  return (
    <div className={styles.app} lang="zh-CN">
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`} aria-label="Plan 导航">
        <div className={styles.brand}><span className={styles.brandMark}><Icon name="spark" size={20} /></span><strong>Plan<span>.</span></strong></div>
        <div className={styles.workspace}><span className={styles.workspaceAvatar}>我</span><div><strong>我的人生规划</strong><span>Personal workspace</span></div></div>
        <label className={styles.search}><Icon name="search" size={15} /><input ref={searchRef} type="search" value={query} placeholder="搜索目标…" aria-label="搜索目标" onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
        <nav className={styles.navigation}>
          <span className={styles.navLabel}>Main menu</span>
          {([["overview", "overview"], ["blueprint", "compass"], ["goals", "goals"]] as [View, IconName][]).map(([id, icon]) => (
            <button key={id} type="button" className={`${styles.navItem} ${view === id ? styles.navActive : ""}`} onClick={() => selectView(id)}><Icon name={icon} size={17} /><span>{viewLabels[id]}</span>{id === "goals" && plan && <small>{plan.goals.length}</small>}</button>
          ))}
        </nav>
        <div className={styles.sidebarAreas}>
          <div className={styles.navLabel}><span>人生领域</span><button type="button" onClick={() => selectView("blueprint")} aria-label="管理人生领域"><Icon name="plus" size={13} /></button></div>
          {plan?.areas.map((area) => (
            <button type="button" key={area.id} className={`${styles.areaNav} ${areaFilter === area.id && view === "goals" ? styles.areaNavActive : ""}`} onClick={() => { setAreaFilter(area.id); setView("goals"); setSidebarOpen(false); }}>
              <span className={styles.areaDot} style={{ background: area.color }} /><span>{area.name}</span><small>{plan.goals.filter((goal) => goal.areaId === area.id && goal.status !== "done").length}</small>
            </button>
          ))}
        </div>
        <div className={styles.sidebarSpacer} />
        <div className={styles.principle}><Icon name="spark" size={17} /><strong>方向比速度更重要</strong><p>先看清全局，再决定下一步。</p></div>
        <Link className={styles.backLink} href="/"><Icon name="back" size={15} />返回 Coding 工作台</Link>
        <div className={styles.profile}><span className={styles.profileAvatar}>ME</span><div><strong>我的长期计划</strong><span><i />本地私密存储</span></div></div>
      </aside>
      {sidebarOpen && <button type="button" className={styles.sidebarBackdrop} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}><button type="button" className={styles.menuButton} onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Icon name="menu" /></button><span>Plan</span><Icon name="chevron" size={12} /><strong>{viewLabels[view]}</strong></div>
          <div className={styles.topActions}><span className={`${styles.saveState} ${saveState === "error" ? styles.saveError : ""}`}><i />{saveState === "saving" ? "正在保存…" : saveState === "error" ? "保存失败" : "所有更改已保存"}</span><button type="button" className={styles.primaryButton} onClick={() => setSelected("new")} disabled={!plan?.areas.length}><Icon name="plus" size={16} />新建目标</button></div>
        </header>

        <div className={styles.content}>
          {!plan ? (
            <div className={styles.loading}><span className={styles.loadingMark}><Icon name="compass" size={28} /></span><h1>{error ? "暂时无法打开 Plan" : "正在展开你的人生地图…"}</h1>{error && <><p>{error}</p><button type="button" className={styles.secondaryButton} onClick={() => void refresh()}>重新加载</button></>}</div>
          ) : (
            <>
              {view === "overview" && <Overview plan={plan} goals={visibleGoals} areaFilter={areaFilter} onAreaFilter={setAreaFilter} onOpen={setSelected} onView={selectView} onMutate={mutate} onError={setError} />}
              {view === "blueprint" && <Blueprint plan={plan} onMutate={saveBlueprint} onError={setError} />}
              {view === "goals" && <GoalsView plan={plan} goals={visibleGoals} areaFilter={areaFilter} onAreaFilter={setAreaFilter} onOpen={setSelected} />}
            </>
          )}
        </div>
      </main>

      {selected && plan && <GoalDialog key={selected} goal={selectedGoal} plan={plan} onClose={() => setSelected(null)} onMutate={mutate} onUpload={upload} onDeleteAttachment={removeAttachment} />}
      {error && plan && <div className={styles.toast} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="关闭错误提示"><Icon name="close" size={15} /></button></div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className={styles.pageHeading}><div><span className={styles.eyebrow}>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Overview({ plan, goals, areaFilter, onAreaFilter, onOpen, onView, onMutate, onError }: {
  plan: PlanSnapshot; goals: PlanGoal[]; areaFilter: string; onAreaFilter: (id: string) => void;
  onOpen: (id: string) => void; onView: (view: View) => void;
  onMutate: (body: Record<string, unknown>) => Promise<void>; onError: (message: string) => void;
}) {
  const active = plan.goals.filter((goal) => goal.status === "active");
  const quarter = plan.goals.filter((goal) => goal.horizon === "quarter" && goal.status !== "done");
  const overall = goalProgress(plan.goals);
  const upcoming = plan.milestones.filter((item) => !item.done).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).slice(0, 5);
  return (
    <>
      <PageHeading eyebrow="MY LIFE, ONE MAP" title="把人生，放回同一张地图。" description="看清长期方向，安排好当下，不让任何一个重要领域悄悄掉队。" action={<button type="button" className={styles.textButton} onClick={() => onView("blueprint")}>查看人生蓝图<Icon name="arrow" size={15} /></button>} />
      <section className={styles.metrics} aria-label="规划摘要">
        <article className={styles.metricCard}>
          <CardTitle icon="target" title="全局目标" subtitle={`覆盖 ${plan.areas.length} 个人生领域`} />
          <div className={styles.metricMain}><div><strong>{active.length}</strong><span>个进行中</span></div><b>{overall}<small>%</small></b></div>
          <div className={styles.gradientTrack}><span style={{ width: `${overall}%` }} /></div>
          <div className={styles.statusLegend}><span><i className={styles.violet} />进行中 <b>{active.length}</b></span><span><i className={styles.orange} />已暂停 <b>{plan.goals.filter((goal) => goal.status === "paused").length}</b></span><span><i className={styles.green} />已完成 <b>{plan.goals.filter((goal) => goal.status === "done").length}</b></span></div>
        </article>
        <article className={styles.metricCard}>
          <CardTitle icon="overview" title="领域推进" subtitle="每个领域都值得被看见" />
          <div className={styles.chartValue}><strong>{goalProgress(quarter)}%</strong><span>本阶段平均完成度</span><small><Icon name="arrow" size={12} />{quarter.length} 项季度目标</small></div>
          <div className={styles.barChart}>{plan.areas.slice(0, 6).map((area) => { const value = goalProgress(plan.goals.filter((goal) => goal.areaId === area.id)); return <div key={area.id}><span><i style={{ height: `${Math.max(value, 6)}%`, background: area.color }} /></span><small>{area.name.slice(0, 1)}</small></div>; })}</div>
        </article>
        <article className={styles.metricCard}>
          <CardTitle icon="compass" title="人生平衡" subtitle="不是满分，而是没有长期缺席" />
          <div className={styles.balanceList}>{plan.areas.slice(0, 4).map((area) => { const value = goalProgress(plan.goals.filter((goal) => goal.areaId === area.id)); return <div key={area.id}><span>{area.name}<b>{value}%</b></span><div><i style={{ width: `${value}%`, background: area.color }} /></div></div>; })}</div>
          <button type="button" className={styles.cardLink} onClick={() => onView("blueprint")}>审视各领域方向<Icon name="arrow" size={13} /></button>
        </article>
      </section>

      <Roadmap plan={plan} goals={goals} areaFilter={areaFilter} onAreaFilter={onAreaFilter} onOpen={onOpen} onManage={() => onView("goals")} />
      <div className={styles.overviewLower}>
        <GoalTable plan={plan} goals={goals.slice(0, 6)} onOpen={onOpen} compact onShowAll={() => onView("goals")} />
        <section className={styles.card}>
          <CardTitle icon="calendar" title="接下来" subtitle="最近的里程碑，不必一次完成所有事" />
          <div className={styles.upcomingList}>{upcoming.map((milestone) => {
            const goal = plan.goals.find((item) => item.id === milestone.goalId);
            const area = plan.areas.find((item) => item.id === goal?.areaId);
            return <div className={styles.upcoming} key={milestone.id}><button type="button" className={styles.checkButton} aria-label={`完成 ${milestone.title}`} onClick={() => { void onMutate({ action: "setMilestoneDone", id: milestone.id, done: true }).catch((cause) => onError(cause instanceof Error ? cause.message : "保存失败")); }}><Icon name="check" size={12} /></button><button type="button" className={styles.upcomingText} onClick={() => goal && onOpen(goal.id)}><strong>{milestone.title}</strong><span><i style={{ background: area?.color }} />{goal?.title}</span></button><time>{formatDate(milestone.dueDate)}</time></div>;
          })}{upcoming.length === 0 && <Empty text="近期没有待办里程碑，给自己留一点空白。" />}</div>
        </section>
      </div>
    </>
  );
}

function CardTitle({ icon, title, subtitle }: { icon: IconName; title: string; subtitle: string }) {
  return <div className={styles.cardTitle}><span><Icon name={icon} size={15} /></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>;
}

function Roadmap({ plan, goals, areaFilter, onAreaFilter, onOpen, onManage }: { plan: PlanSnapshot; goals: PlanGoal[]; areaFilter: string; onAreaFilter: (id: string) => void; onOpen: (id: string) => void; onManage: () => void }) {
  return (
    <section className={`${styles.card} ${styles.roadmapCard}`}>
      <div className={styles.sectionHeader}><CardTitle icon="calendar" title="全局路线图" subtitle="把不同领域的目标，放进同一条时间线" /><div className={styles.sectionActions}><select aria-label="筛选路线图领域" value={areaFilter} onChange={(event) => onAreaFilter(event.target.value)}><option value="all">全部领域</option>{plan.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select><button type="button" className={styles.secondaryButton} onClick={onManage}>管理目标</button></div></div>
      <div className={styles.roadmapScroll}><div className={styles.roadmap}>
        <div className={styles.roadmapHeader}><span>人生领域</span>{Object.entries(horizonLabels).map(([key, label]) => <span key={key}><Icon name={key === "quarter" ? "target" : key === "year" ? "calendar" : "compass"} size={13} />{label}</span>)}</div>
        {plan.areas.filter((area) => areaFilter === "all" || area.id === areaFilter).map((area) => {
          const areaGoals = goals.filter((goal) => goal.areaId === area.id);
          if (areaFilter === "all" && areaGoals.length === 0) return null;
          return <div className={styles.roadmapRow} key={area.id}><div className={styles.roadmapArea}><span style={{ color: area.color, background: `${area.color}16` }}><Icon name={areaIcon(area.id)} size={15} /></span><strong>{area.name}</strong></div>{(["quarter", "year", "future"] as PlanHorizon[]).map((horizon) => <div className={styles.roadmapCell} key={horizon}>{areaGoals.filter((goal) => goal.horizon === horizon).map((goal) => <button type="button" key={goal.id} className={`${styles.roadmapGoal} ${goal.status === "done" ? styles.goalDone : ""}`} style={{ "--area-color": area.color } as CSSProperties} onClick={() => onOpen(goal.id)}><span><strong>{goal.title}</strong><small>{goal.status === "done" ? "已完成" : formatDate(goal.dueDate)}</small></span><b>{goal.progress}%</b><i><em style={{ width: `${goal.progress}%` }} /></i></button>)}</div>)}</div>;
        })}
        {goals.length === 0 && <Empty text="没有符合筛选条件的目标。新建一个目标，让路线图开始运转。" />}
      </div></div>
    </section>
  );
}

function GoalTable({ plan, goals, onOpen, compact = false, onShowAll }: { plan: PlanSnapshot; goals: PlanGoal[]; onOpen: (id: string) => void; compact?: boolean; onShowAll?: () => void }) {
  return (
    <section className={`${styles.card} ${styles.goalTableCard}`}>
      <div className={styles.sectionHeader}><CardTitle icon="goals" title={compact ? "目标清单" : "所有目标"} subtitle="每一个目标，都应对应一个想去的方向" />{onShowAll && <button type="button" className={styles.textButton} onClick={onShowAll}>查看全部<Icon name="arrow" size={14} /></button>}</div>
      <div className={styles.tableScroll}><table className={styles.goalTable}><thead><tr><th>目标</th><th>时间</th><th>里程碑</th><th>状态</th><th>完成度</th><th><span className={styles.srOnly}>操作</span></th></tr></thead><tbody>{goals.map((goal) => {
        const area = plan.areas.find((item) => item.id === goal.areaId);
        const milestones = plan.milestones.filter((item) => item.goalId === goal.id);
        return <tr key={goal.id}><td><button type="button" className={styles.goalName} onClick={() => onOpen(goal.id)}><span style={{ color: area?.color, background: `${area?.color ?? "#7567e8"}16` }}><Icon name={areaIcon(goal.areaId)} size={16} /></span><span><strong>{goal.title}</strong><small>{area?.name} · {horizonLabels[goal.horizon]}</small></span></button></td><td><span className={styles.dateCell}>{formatDate(goal.dueDate)}</span></td><td><span className={styles.milestoneCount}>{milestones.filter((item) => item.done).length}/{milestones.length || 0}</span></td><td><span className={`${styles.statusBadge} ${styles[`status_${goal.status}`]}`}><i />{statusLabels[goal.status]}</span></td><td><div className={styles.progressCell}><span className={styles.progressRing} style={{ background: `conic-gradient(${area?.color ?? "#7567e8"} ${goal.progress * 3.6}deg, #eceef3 0deg)` }}><i>{goal.progress}</i></span><small>%</small></div></td><td><button type="button" className={styles.rowArrow} onClick={() => onOpen(goal.id)} aria-label={`编辑 ${goal.title}`}><Icon name="arrow" size={15} /></button></td></tr>;
      })}</tbody></table>{goals.length === 0 && <Empty text="这里还没有目标。点击“新建目标”，写下一个真正重要的结果。" />}</div>
    </section>
  );
}

function GoalsView({ plan, goals, areaFilter, onAreaFilter, onOpen }: { plan: PlanSnapshot; goals: PlanGoal[]; areaFilter: string; onAreaFilter: (id: string) => void; onOpen: (id: string) => void }) {
  return <><PageHeading eyebrow="GOALS WITH DIRECTION" title="目标不是清单，是选择。" description="按领域和时间审视目标，保留真正重要的，暂停不再合适的。" action={<select className={styles.headingSelect} aria-label="筛选目标领域" value={areaFilter} onChange={(event) => onAreaFilter(event.target.value)}><option value="all">全部人生领域</option>{plan.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select>} /><GoalTable plan={plan} goals={goals} onOpen={onOpen} /></>;
}

function Blueprint({ plan, onMutate, onError }: { plan: PlanSnapshot; onMutate: (body: Record<string, unknown>) => Promise<void>; onError: (message: string) => void }) {
  const save = async (body: Record<string, unknown>): Promise<boolean> => {
    try { await onMutate(body); onError(""); return true; }
    catch (cause) { onError(cause instanceof Error ? cause.message : "保存失败"); return false; }
  };
  return (
    <>
      <PageHeading eyebrow="YOUR NORTH STAR" title="先定义方向，再安排人生。" description="愿景不追求精确预测未来，它帮你在每一次选择时，知道什么更重要。" />
      <div className={styles.visionGrid}>
        <BlueprintText className={styles.lifeVision} icon="compass" label="我的人生愿景" hint="当三年后回看，我希望自己如何生活、创造与相处？" value={plan.meta.vision} onSave={(value) => save({ action: "saveMeta", key: "vision", value })} />
        <BlueprintText className={styles.focusVision} icon="target" label="当前阶段的主线" hint="这一阶段只抓住一条最重要的主线，它是什么？" value={plan.meta.focus} onSave={(value) => save({ action: "saveMeta", key: "focus", value })} />
      </div>
      <div className={styles.blueprintHeading}><div><span className={styles.eyebrow}>LIFE DOMAINS</span><h2>各个领域，想去哪里？</h2><p>为每个领域写下一句方向，再用目标让它发生。</p></div><span>离开输入框自动保存</span></div>
      <div className={styles.areaGrid}>{plan.areas.map((area) => <AreaVision key={area.id} area={area} progress={goalProgress(plan.goals.filter((goal) => goal.areaId === area.id))} onSave={(vision) => save({ action: "updateArea", ...area, vision })} />)}<AddArea onSave={(input) => save({ action: "createArea", ...input })} /></div>
    </>
  );
}

function BlueprintText({ icon, label, hint, value, className, onSave }: { icon: IconName; label: string; hint: string; value: string; className: string; onSave: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <section className={`${styles.card} ${styles.visionCard} ${className}`}><div className={styles.visionLabel}><span><Icon name={icon} size={18} /></span><h2>{label}</h2></div><p>{hint}</p><textarea aria-label={label} rows={4} value={draft} maxLength={5000} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) void onSave(draft); }} /></section>;
}

function AreaVision({ area, progress, onSave }: { area: PlanArea; progress: number; onSave: (vision: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(area.vision);
  useEffect(() => setDraft(area.vision), [area.vision]);
  return <article className={styles.areaVision} style={{ "--area-color": area.color } as CSSProperties}><div className={styles.areaVisionTop}><span><Icon name={areaIcon(area.id)} size={19} /></span><div><h3>{area.name}</h3><small>{progress}% 目标完成度</small></div><b>{progress}</b></div><div className={styles.areaTrack}><i style={{ width: `${progress}%` }} /></div><p>这个领域的理想状态</p><textarea aria-label={`${area.name}领域愿景`} rows={3} value={draft} maxLength={2000} placeholder="写下你希望这里成为什么样…" onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== area.vision) void onSave(draft); }} /></article>;
}

function AddArea({ onSave }: { onSave: (input: { name: string; vision: string; color: string }) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [vision, setVision] = useState("");
  const [color, setColor] = useState("#9b8af5");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void onSave({ name, vision, color }).then((saved) => { if (saved) { setName(""); setVision(""); setOpen(false); } });
  };
  if (!open) return <button type="button" className={styles.addArea} onClick={() => setOpen(true)}><span><Icon name="plus" size={20} /></span><strong>添加人生领域</strong><small>你的地图，不必使用别人的分类</small></button>;
  return <form className={styles.addAreaForm} onSubmit={submit}><div><input type="color" aria-label="领域颜色" value={color} onChange={(event) => setColor(event.target.value)} /><input autoFocus aria-label="领域名称" placeholder="领域名称" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></div><textarea aria-label="领域愿景" placeholder="这个领域的理想状态…" rows={3} value={vision} maxLength={2000} onChange={(event) => setVision(event.target.value)} /><div><button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>取消</button><button type="submit" className={styles.primaryButton} disabled={!name.trim()}>添加</button></div></form>;
}

function Empty({ text }: { text: string }) {
  return <div className={styles.empty}><Icon name="compass" size={20} /><p>{text}</p></div>;
}
