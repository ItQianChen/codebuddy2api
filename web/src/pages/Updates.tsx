import { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router";
import { api, errorMessage, list, number, object, text, useResource } from "../api";
import { useT } from "../i18n";
import { Badge, Empty, ErrorNotice, Icon, PageTitle, Panel, ResourceState } from "../components";
import { Markdown } from "../markdown";
import { MirrorPanel } from "../MirrorPanel";
import { UpdateProgress, type UpdateJob } from "../UpdateProgress";
import s from "../ui.module.scss";

type Release = {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  installable: boolean;
};
type UpdateState = {
  current: string;
  repository: string;
  deployment: string;
  selfUpdate: boolean;
  blockReason: string | null;
  checkedAt: number | null;
  error: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releases: Release[];
  job: UpdateJob;
  mirror: string;
  mirrors: string[];
  mirrorLocked: boolean;
};

// Fast enough for the download bar to move smoothly; the job lives on the server.
const JOB_POLL = 800;

function optional(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
// Only https links leave the dashboard; anything else renders as plain text.
function safeUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

function normalize(value: unknown): UpdateState {
  const d = object(value, "更新状态");
  const self = object(d.self_update ?? {}, "更新状态");
  const job = object(d.job ?? {}, "更新任务");
  return {
    current: text(d.current),
    repository: safeUrl(d.repository) ?? "",
    deployment: text(d.deployment),
    selfUpdate: self.available === true,
    blockReason: optional(self.reason),
    checkedAt: number(d.checked_at),
    error: optional(d.error),
    latest: optional(d.latest),
    updateAvailable: d.update_available === true,
    releases: list(d.releases, "版本列表").map((item) => ({
      tag: text(item.tag),
      version: text(item.version),
      name: text(item.name),
      notes: typeof item.notes === "string" ? item.notes : "",
      publishedAt: optional(item.published_at),
      url: safeUrl(item.url) ?? "",
      installable: item.installable === true,
    })),
    job: {
      status: text(job.status),
      step: optional(job.step),
      target: optional(job.target),
      message: optional(job.message),
      backup: optional(job.backup),
      received: number(job.received),
      total: number(job.total),
    },
    mirror: typeof d.mirror === "string" ? d.mirror : "",
    mirrors: Array.isArray(d.mirrors)
      ? d.mirrors.filter((item): item is string => typeof item === "string")
      : [],
    mirrorLocked: d.mirror_locked === true,
  };
}

function newer(version: string, current: string): boolean {
  const a = version.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

function date(value: string | number | null): string {
  if (value === null) return "—";
  const parsed = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("zh-CN");
}

function InstallAction({
  release,
  current,
  deployment,
  onStarted,
}: {
  release: Release;
  current: string;
  deployment: string;
  onStarted: () => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upgrade = newer(release.version, current);
  const label = t(upgrade ? "updates.install" : "updates.rollback", { tag: release.tag });
  if (!confirming)
    return (
      <div>
        <button className={upgrade ? s.primary : ""} onClick={() => setConfirming(true)}>
          <Icon name={upgrade ? "up" : "down"} />
          {label}
        </button>
      </div>
    );
  return (
    <div className={s.cleanupBox}>
      <div>
        <strong>{label}</strong>
        <p>{t(upgrade ? "updates.confirm" : "updates.confirmRollback", { tag: release.tag })}</p>
        {(deployment === "git" || deployment === "docker") && (
          <p>{t(`updates.note.${deployment}`)}</p>
        )}
        <ErrorNotice message={error} />
      </div>
      <span className={s.confirmActions}>
        <button disabled={busy} onClick={() => setConfirming(false)}>
          {t("updates.cancel")}
        </button>
        <button
          className={s.primary}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void api
              .post("/update/install", { tag: release.tag })
              .then(onStarted)
              .catch((err: unknown) => {
                setError(errorMessage(err));
                setBusy(false);
              });
          }}
        >
          {t("updates.confirmInstall")}
        </button>
      </span>
    </div>
  );
}

function Guidance({ deployment }: { deployment: string }) {
  const t = useT();
  if (deployment === "docker")
    return (
      <pre className={s.codeBlock}>
        {`${t("updates.guide.docker")}
docker compose pull
docker compose up -d --no-build

${t("updates.guide.dockerAuto")}
0 4 * * * cd /path/to/codebuddy2api && docker compose pull -q && docker compose up -d --no-build`}
      </pre>
    );
  if (deployment === "git")
    return (
      <pre className={s.codeBlock}>
        {`${t("updates.guide.git")}
git pull --ff-only
uv sync --locked --no-build
(cd web && vp install --frozen-lockfile && vp build)

${t("updates.guide.restart")}`}
      </pre>
    );
  return null;
}

export function Updates() {
  const t = useT();
  const { tag } = useParams();
  const resource = useResource("/update", normalize);
  const { reload } = resource;
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const d = resource.data;
  const running = d?.job.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(reload, JOB_POLL);
    return () => clearTimeout(timer);
  }, [running, d, reload]);
  const busy = running || d?.job.status === "restarting";
  const latest = d?.releases[0];
  const selected = d && (tag ? d.releases.find((item) => item.tag === tag) : latest);
  const canInstall = (release: Release | undefined): release is Release =>
    Boolean(d?.selfUpdate && !busy && release?.installable && release.version !== d.current);
  const install = (release: Release) =>
    d && (
      <InstallAction
        release={release}
        current={d.current}
        deployment={d.deployment}
        onStarted={reload}
      />
    );
  return (
    <>
      <PageTitle
        title={t("updates.title")}
        description={t("updates.desc")}
        actions={
          <>
            {d && (
              <Badge tone={d.updateAvailable ? "warn" : d.latest ? "good" : "neutral"}>
                v{d.current}
              </Badge>
            )}
            <button
              disabled={checking}
              onClick={() => {
                setChecking(true);
                setCheckError(null);
                void api
                  .post("/update/check")
                  .then(reload)
                  .catch((err: unknown) => setCheckError(errorMessage(err)))
                  .finally(() => setChecking(false));
              }}
            >
              <Icon name="refresh" />
              {checking ? t("updates.checking") : t("updates.check")}
            </button>
          </>
        }
      />
      <ResourceState {...resource} />
      <ErrorNotice message={checkError ?? d?.error ?? null} />
      {d && (
        <>
          <div className={s.kpiGrid}>
            <article className={s.kpiCard}>
              <div>
                <span>{t("updates.current")}</span>
                <span>
                  <Icon name="leaf" />
                </span>
              </div>
              <strong>v{d.current}</strong>
              <small>{t(`updates.deploy.${d.deployment}`)}</small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("updates.latest")}</span>
                <span>
                  <Icon name="up" />
                </span>
              </div>
              <strong>{d.latest ? `v${d.latest}` : "—"}</strong>
              <small>
                {d.updateAvailable
                  ? t("updates.available")
                  : d.latest
                    ? t("updates.upToDate")
                    : t("updates.unknown")}
              </small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("updates.checkedAt")}</span>
                <span>
                  <Icon name="refresh" />
                </span>
              </div>
              <strong className={s.kpiText}>
                {d.checkedAt ? date(d.checkedAt) : t("updates.never")}
              </strong>
              <small>{t("updates.autoCheck")}</small>
            </article>
          </div>
          <div className={s.stack}>
            <div className={s.storageSplit}>
              <Panel title={t("updates.panel")} hint={t("updates.panelHint")}>
                <div className={s.panelBody}>
                  <p className={s.storageLead}>
                    {t("updates.repository")}：
                    {d.repository ? (
                      <a href={d.repository} target="_blank" rel="noreferrer">
                        {d.repository}
                      </a>
                    ) : (
                      "—"
                    )}
                  </p>
                  <UpdateProgress job={d.job} />
                  {d.selfUpdate ? (
                    d.updateAvailable && canInstall(latest) ? (
                      install(latest)
                    ) : (
                      !busy && (
                        <p className={s.storageLead}>
                          {d.latest ? t("updates.upToDate") : t("updates.unknown")}
                        </p>
                      )
                    )
                  ) : (
                    <>
                      <p className={s.storageLead}>{d.blockReason}</p>
                      <Guidance deployment={d.deployment} />
                    </>
                  )}
                </div>
              </Panel>
              <MirrorPanel
                mirror={d.mirror}
                mirrors={d.mirrors}
                locked={d.mirrorLocked}
                onSaved={reload}
              />
            </div>
            <Panel title={t("updates.releases")} hint={t("updates.releasesHint")}>
              {d.releases.length ? (
                <div className={s.releaseLayout}>
                  <nav className={s.releaseList} aria-label={t("updates.releases")}>
                    {d.releases.map((release) => (
                      <NavLink
                        key={release.tag}
                        to={`/dashboard/updates/${release.tag}`}
                        className={({ isActive }) =>
                          `${s.releaseItem} ${isActive || (!tag && release === latest) ? s.active : ""}`
                        }
                      >
                        <strong>{release.tag}</strong>
                        <span>{date(release.publishedAt)}</span>
                        {release === latest && (
                          <Badge tone="good">{t("updates.badge.latest")}</Badge>
                        )}
                        {release.version === d.current && (
                          <Badge>{t("updates.badge.current")}</Badge>
                        )}
                      </NavLink>
                    ))}
                  </nav>
                  <article className={s.releaseNotes}>
                    {selected ? (
                      <>
                        <div className={s.releaseHead}>
                          <div>
                            <h2>{selected.name}</h2>
                            <small>{date(selected.publishedAt)}</small>
                          </div>
                          {selected.url && (
                            <a href={selected.url} target="_blank" rel="noreferrer">
                              {t("updates.openGithub")}
                            </a>
                          )}
                        </div>
                        {/* The latest upgrade already has its button in the update panel. */}
                        {canInstall(selected) &&
                          !(d.updateAvailable && selected === latest) &&
                          install(selected)}
                        {selected.notes.trim() ? (
                          <Markdown source={selected.notes} />
                        ) : (
                          <Empty title={t("updates.noNotes")} />
                        )}
                      </>
                    ) : (
                      <Empty title={t("updates.notFound")} />
                    )}
                  </article>
                </div>
              ) : (
                <div className={s.panelBody}>
                  <Empty title={t("updates.emptyReleases")} />
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
