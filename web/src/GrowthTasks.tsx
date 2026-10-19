import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, object, text, type Credential } from "./api";
import s from "./ui.module.scss";

type GrowthTask = {
  task_code: string;
  title: string;
  description: string;
  credit: number;
  energy: number;
  locked: boolean;
  accept_status: string;
  target: number;
  current: number;
  claimable: boolean;
  claimed: boolean;
  group: string;
};

type GrowthView = {
  supported: boolean;
  auto_growth: boolean;
  growth_auto: Record<string, boolean>;
  tasks: GrowthTask[];
  message?: string;
  stale?: boolean;
};

const GROUP_LABELS: Record<string, string> = {
  behavior: "行为上报",
  chat: "真实对话",
  miniprogram: "小程序",
};

/** 成长计划子栏：仅国内个人账号渲染（上游成长中心为个人 CN 专属）。 */
export function GrowthTasks({
  credential,
  busy,
  onPreference,
  selectedIds,
}: {
  credential: Credential;
  busy: boolean;
  onPreference: (c: Credential, field: "auto_growth", enabled: boolean) => void;
  selectedIds: string[];
}) {
  const [view, setView] = useState<GrowthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const load = useCallback(async () => {
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    try {
      const response = await api.get(
        `/credentials/${encodeURIComponent(credential.id)}/growth-tasks`,
        { signal: abort.signal },
      );
      setView(object(response.data, "成长任务") as unknown as GrowthView);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }, [credential.id]);

  useEffect(() => {
    load();
  }, [load]);

  const runTask = async (code: string) => {
    if (controller.current || busy || running) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(code);
    setError(null);
    setNotice(null);
    try {
      const response = await api.post(
        `/credentials/${encodeURIComponent(credential.id)}/growth-tasks/auto`,
        { task_code: code },
        { signal: abort.signal, timeout: 300000 },
      );
      const data = object(response.data, "任务结果");
      setNotice(data.message ? text(data.message) : "已执行");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (controller.current === abort) controller.current = null;
      setRunning(null);
    }
  };

  const runAll = async () => {
    if (controller.current || busy || running) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning("__all__");
    setError(null);
    setNotice(null);
    try {
      const response = await api.post(
        `/credentials/${encodeURIComponent(credential.id)}/growth-tasks/auto-all`,
        {},
        { signal: abort.signal, timeout: 600000 },
      );
      const data = object(response.data, "任务结果");
      const results = Array.isArray(data.results) ? data.results : [];
      const claimed = results.filter((r) => object(r).claimed === true).length;
      setNotice(`已执行 ${results.length} 个任务，其中 ${claimed} 个领奖`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (controller.current === abort) controller.current = null;
      setRunning(null);
    }
  };

  const toggleTask = async (code: string, enabled: boolean) => {
    if (busy || !view) return;
    const mapping = { ...view.growth_auto, [code]: enabled };
    setError(null);
    try {
      await api.patch(`/credentials/${encodeURIComponent(credential.id)}`, {
        growth_auto: mapping,
      });
      setView({ ...view, growth_auto: mapping });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const syncToSelected = async () => {
    if (busy || !view || !selectedIds.length) return;
    setError(null);
    setNotice(null);
    try {
      for (const id of selectedIds) {
        if (id === credential.id) continue;
        for (const [code, enabled] of Object.entries(view.growth_auto)) {
          await api.post("/credentials/growth-batch", {
            ids: [id],
            task_codes: [code],
            enabled,
          });
        }
      }
      setNotice(
        `已把本账号的任务开关同步到 ${selectedIds.filter((id) => id !== credential.id).length} 个已选账号`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (view?.stale === true) return <small>凭证已变化，请刷新后重新打开成长任务</small>;
  if (view && view.supported === false) return null; // 非 CN 个人账号：整个子栏隐藏
  if (!view) return <small>{error ? text(error) : "成长任务加载中…"}</small>;

  const groups: Record<string, GrowthTask[]> = {};
  for (const task of view.tasks) {
    (groups[task.group] ??= []).push(task);
  }

  return (
    <div className={s.credCardTasks}>
      <div className={s.credTaskRow}>
        <label className={s.check}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`自动成长补领 ${credential.name ?? credential.id}`}
            checked={view.auto_growth === true}
            disabled={busy}
            onChange={(e) => onPreference(credential, "auto_growth", e.target.checked)}
          />
          自动成长补领
        </label>
        <small>仅补齐「已达标未领」的奖励，不发起对话或行为上报</small>
      </div>
      {Object.entries(groups).map(([group, tasks]) => (
        <div key={group}>
          <small>
            <strong>{GROUP_LABELS[group] ?? "其他"}</strong>
            {group === "chat" ? "（开启即授权消耗该账号对话额度）" : ""}
          </small>
          {tasks.map((task) => (
            <div key={task.task_code} className={s.credTaskRow}>
              <label className={s.check}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`自动${task.title} ${credential.name ?? credential.id}`}
                  checked={view.growth_auto[task.task_code] === true}
                  disabled={busy}
                  onChange={(e) => toggleTask(task.task_code, e.target.checked)}
                />
                {task.title}
              </label>
              <small>
                {task.claimed
                  ? "已领取"
                  : `${task.current}/${task.target || "—"}${
                      task.credit || task.energy ? ` · +${task.credit}c +${task.energy}e` : ""
                    }`}
                <button
                  disabled={busy || running !== null || task.claimed || task.locked}
                  aria-label={`一键完成${task.title} ${credential.name ?? credential.id}`}
                  onClick={() => runTask(task.task_code)}
                >
                  {running === task.task_code ? "执行中…" : "一键完成"}
                </button>
              </small>
              {task.locked && <small>未解锁（按官方节奏逐日开放）</small>}
            </div>
          ))}
        </div>
      ))}
      <div className={s.credTaskRow}>
        <button
          disabled={busy || running !== null}
          aria-label={`全部执行 ${credential.name ?? credential.id}`}
          onClick={runAll}
        >
          {running === "__all__" ? "执行中…" : "全部执行（已开开关的任务）"}
        </button>
        {selectedIds.some((id) => id !== credential.id) && (
          <button
            disabled={busy}
            aria-label={`同步开关到已选账号 ${credential.name ?? credential.id}`}
            onClick={syncToSelected}
          >
            同步开关到已选账号 ({selectedIds.filter((id) => id !== credential.id).length})
          </button>
        )}
      </div>
      {notice && <small>{text(notice)}</small>}
      {error && <small>{text(error)}</small>}
    </div>
  );
}
