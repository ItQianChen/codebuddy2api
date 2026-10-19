import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { Credentials } from "./pages/Credentials";
import { api, credentialResponse, useResource, type Credential } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));
beforeEach(() => vi.restoreAllMocks());

function openDetail(credentialName: string) {
  const row = screen
    .getAllByText(credentialName)
    .map((el) => el.closest<HTMLElement>("tr, article"))
    .find(
      (tr) =>
        tr && within(tr).queryByRole("button", { name: new RegExp(`任务配置.*${credentialName}`) }),
    );
  if (!row) throw new Error(`row for ${credentialName} not found`);
  fireEvent.click(
    within(row).getByRole("button", { name: new RegExp(`任务配置.*${credentialName}`) }),
  );
}

function fixture() {
  const rows: Credential[] = credentialResponse({
    credentials: [
      {
        id: "cnwork",
        account_key: "cnwork",
        name: "cn-work.info",
        profile: "cn-work",
        enabled: true,
        health: "ready",
        auto_checkin: true,
        auto_travel: true,
        travel_supported: true,
        growth_supported: true,
        auto_growth: true,
        growth_auto: { chat_5: true },
        checkin: { state: "success", date: "2026-10-19", message: "签到成功" },
      },
      {
        id: "intl",
        account_key: "intl",
        name: "intl-work.info",
        profile: "intl-work",
        enabled: true,
        health: "ready",
        growth_supported: false,
        auto_checkin: false,
        travel_supported: false,
      },
    ],
  });
  const reload = vi.fn();
  vi.mocked(useResource).mockReturnValue({ data: rows, reload, loading: false, error: null });
  return { rows, reload };
}

const growthView = {
  supported: true,
  auto_growth: true,
  growth_auto: { chat_5: true },
  tasks: [
    {
      task_code: "chat_5",
      title: "对话活跃补报",
      description: "",
      credit: 100,
      energy: 0,
      locked: false,
      accept_status: "accepted",
      target: 5,
      current: 5,
      claimable: true,
      claimed: false,
      group: "behavior",
    },
    {
      task_code: "Model_chat_GLM5.2",
      title: "GLM-5.2 真实对话",
      description: "",
      credit: 100,
      energy: 5,
      locked: false,
      accept_status: "not_accepted",
      target: 1,
      current: 0,
      claimable: false,
      claimed: false,
      group: "chat",
    },
  ],
};

it("shows the growth drawer only for CN personal accounts and lists grouped tasks", async () => {
  fixture();
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    expect(url).toBe("/credentials/cnwork/growth-tasks");
    return { data: growthView } as never;
  });
  render(<Credentials />);
  openDetail("cn-work.info");
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(await screen.findByText("成长计划")).toBeTruthy();
  expect(screen.getByText("行为上报")).toBeTruthy();
  expect(screen.getByText("真实对话")).toBeTruthy();
  expect(screen.getByText("（开启即授权消耗该账号对话额度）")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "自动对话活跃补报 cn-work.info" })).toHaveProperty(
    "checked",
    true,
  );
  expect(screen.getByRole("switch", { name: "自动GLM-5.2 真实对话 cn-work.info" })).toHaveProperty(
    "checked",
    false,
  );
});

it("hides the growth drawer for non-CN accounts", async () => {
  fixture();
  const get = vi.spyOn(api, "get");
  render(<Credentials />);
  openDetail("intl-work.info");
  await act(async () => {});
  expect(screen.queryByText("成长计划")).toBeNull();
  expect(get).not.toHaveBeenCalled();
});

it("patches the per-task switch by merging the current mapping", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const patch = vi.spyOn(api, "patch").mockResolvedValue({
    data: { id: "cnwork", revision: 7 },
  } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const taskSwitch = await screen.findByRole("switch", {
    name: "自动GLM-5.2 真实对话 cn-work.info",
  });
  await act(async () => fireEvent.click(taskSwitch));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch).toHaveBeenCalledWith("/credentials/cnwork", {
    growth_auto: { chat_5: true, "Model_chat_GLM5.2": true },
  });
});

it("runs one task manually and surfaces the claim result", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const post = vi.spyOn(api, "post").mockResolvedValue({
    data: {
      id: "cnwork",
      task_code: "chat_5",
      ok: true,
      claimed: true,
      message: "已补报 2 条对话活跃事件；已自动领奖 +100c +0e",
    },
  } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const button = await screen.findByRole("button", { name: "一键完成对话活跃补报 cn-work.info" });
  await act(async () => fireEvent.click(button));
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith(
    "/credentials/cnwork/growth-tasks/auto",
    { task_code: "chat_5" },
    expect.objectContaining({ timeout: 300000 }),
  );
  expect(await screen.findByText(/已自动领奖 \+100c \+0e/)).toBeTruthy();
});

it("syncs the account's task switches to every other selected account", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { updated: 1 } } as never);
  render(<Credentials />);
  // 勾选另一个账号后，抽屉里的「同步开关」才出现。
  const intlRow = screen
    .getAllByText("intl-work.info")
    .map((el) => el.closest<HTMLElement>("tr, article"))
    .find((tr) => tr && within(tr).queryByRole("checkbox"));
  if (!intlRow) throw new Error("intl row not found");
  await act(async () => fireEvent.click(within(intlRow).getByRole("checkbox")));
  openDetail("cn-work.info");
  const sync = await screen.findByRole("button", { name: "同步开关到已选账号 cn-work.info" });
  await act(async () => fireEvent.click(sync));
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith("/credentials/growth-batch", {
    ids: ["intl"],
    task_codes: ["chat_5"],
    enabled: true,
  });
});
