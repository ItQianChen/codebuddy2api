import { useState } from "react";
import { api, errorMessage, list, number, text } from "./api";
import { Badge, ErrorNotice, Icon, Panel } from "./components";
import { useT } from "./i18n";
import s from "./ui.module.scss";

type Probe = {
  mirror: string;
  ok: boolean;
  latency: number | null;
  speed: number | null;
  error: string | null;
};

const CUSTOM = "custom";

function host(mirror: string): string {
  try {
    const url = new URL(mirror);
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return mirror;
  }
}

function rate(speed: number): string {
  return speed >= 1024 ? `${(speed / 1024).toFixed(1)} MB/s` : `${Math.round(speed)} KB/s`;
}

export function MirrorPanel({
  mirror,
  mirrors,
  locked,
  onSaved,
}: {
  mirror: string;
  mirrors: string[];
  locked: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const preset = mirror === "" || mirrors.includes(mirror);
  const [choice, setChoice] = useState(preset ? mirror : CUSTOM);
  const [custom, setCustom] = useState(preset ? "" : mirror);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Probe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = choice === CUSTOM ? custom.trim() : choice;
  const label = (candidate: string) => (candidate ? host(candidate) : t("updates.mirrorDirect"));
  const save = (next: string) => {
    setSaving(true);
    setError(null);
    void api
      .post("/update/mirror", { mirror: next })
      .then(onSaved)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSaving(false));
  };
  const choose = (next: string) => {
    if (next === "" || mirrors.includes(next)) setChoice(next);
    else {
      setChoice(CUSTOM);
      setCustom(next);
    }
    save(next);
  };
  return (
    <Panel title={t("updates.mirror")} hint={t("updates.mirrorHint")}>
      <div className={s.panelBody}>
        <p className={s.storageLead}>{t("updates.mirrorDesc")}</p>
        <form
          className={s.archiveForm}
          onSubmit={(e) => {
            e.preventDefault();
            save(value);
          }}
        >
          <label className={s.field}>
            {t("updates.mirrorSource")}
            <select value={choice} disabled={locked} onChange={(e) => setChoice(e.target.value)}>
              <option value="">{t("updates.mirrorDirect")}</option>
              {mirrors.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {host(candidate)}
                </option>
              ))}
              <option value={CUSTOM}>{t("updates.mirrorCustom")}</option>
            </select>
          </label>
          {choice === CUSTOM && (
            <label className={s.field}>
              {t("updates.mirrorCustomLabel")}
              <input
                value={custom}
                disabled={locked}
                placeholder="https://example.com/"
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>
          )}
          <button className={s.primary} disabled={locked || saving || value === mirror}>
            {t("updates.mirrorSave")}
          </button>
          <button
            type="button"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setError(null);
              void api
                .post<unknown>("/update/mirrors/test", undefined, { timeout: 60000 })
                .then((response) => {
                  const data = response.data as { results?: unknown };
                  setResults(
                    list(data.results, t("updates.mirror")).map((item) => ({
                      mirror: typeof item.mirror === "string" ? item.mirror : "",
                      ok: item.ok === true,
                      latency: number(item.latency_ms),
                      speed: number(item.speed),
                      error: item.error ? text(item.error) : null,
                    })),
                  );
                })
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setTesting(false));
            }}
          >
            <Icon name="refresh" />
            {testing ? t("updates.mirrorTesting") : t("updates.mirrorTest")}
          </button>
        </form>
        {locked && <small className={s.storageSubtle}>{t("updates.mirrorLocked")}</small>}
        <ErrorNotice message={error} />
        {results && (
          <ul className={s.mirrorList} aria-label={t("updates.mirrorResults")}>
            {results.map((probe, position) => (
              <li key={probe.mirror} className={probe.mirror === mirror ? s.mirrorCurrent : ""}>
                <span className={s.mirrorName}>
                  {label(probe.mirror)}
                  {position === 0 && probe.ok && (
                    <Badge tone="good">{t("updates.mirrorFastest")}</Badge>
                  )}
                  {probe.mirror === mirror && <Badge>{t("updates.mirrorInUse")}</Badge>}
                </span>
                <span className={s.mirrorStats}>
                  {probe.ok && probe.speed !== null ? (
                    `${probe.latency ?? "—"} ms · ${rate(probe.speed)}`
                  ) : (
                    <Badge tone="bad">{probe.error ?? "—"}</Badge>
                  )}
                </span>
                <button
                  type="button"
                  disabled={!probe.ok || locked || saving || probe.mirror === mirror}
                  onClick={() => choose(probe.mirror)}
                >
                  {t("updates.mirrorUse")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
