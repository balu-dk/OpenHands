import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentNotification } from "#/hooks/use-agent-notification";
import { AgentState } from "#/types/agent-state";
import * as browserTabModule from "#/utils/browser-tab";
import { showBrowserNotification } from "#/utils/browser-notifications";

// Mock useSettings to control the sound notification setting
vi.mock("#/hooks/query/use-settings", () => ({
  useSettings: vi.fn().mockReturnValue({
    data: { enable_sound_notifications: true },
  }),
}));

// Mock the OS-level notification layer
vi.mock("#/utils/browser-notifications", () => ({
  showBrowserNotification: vi.fn(),
}));

// Spy on browserTab methods
vi.spyOn(browserTabModule.browserTab, "startNotification");
vi.spyOn(browserTabModule.browserTab, "stopNotification");

// Mock Audio
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockAudio = {
  play: mockPlay,
  currentTime: 0,
  volume: 0.5,
};

class MockAudio {
  play = mockPlay;
  currentTime = 0;
  volume = 0.5;
  constructor() {
    Object.assign(this, mockAudio);
    return mockAudio as unknown as MockAudio;
  }
}
vi.stubGlobal("Audio", MockAudio);

describe("useAgentNotification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Simulate tab not focused
    Object.defineProperty(document, "hasFocus", {
      value: () => false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore hasFocus
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
  });

  it("starts browser tab notification when agent reaches FINISHED state and tab is not focused", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    // Transition to FINISHED
    rerender({ state: AgentState.FINISHED });

    expect(
      browserTabModule.browserTab.startNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it("plays notification sound when agent reaches FINISHED state and sound is enabled", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    // Transition to FINISHED
    rerender({ state: AgentState.FINISHED });

    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it("starts notification when agent reaches AWAITING_USER_INPUT state", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    // Transition to AWAITING_USER_INPUT
    rerender({ state: AgentState.AWAITING_USER_INPUT });

    expect(
      browserTabModule.browserTab.startNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it("starts notification when agent reaches AWAITING_USER_CONFIRMATION state", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.AWAITING_USER_CONFIRMATION });

    expect(
      browserTabModule.browserTab.startNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it("stops browser tab notification when window gains focus", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.FINISHED });

    // Simulate window focus
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(
      browserTabModule.browserTab.stopNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not start tab flash when focused, but still plays sound", () => {
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });

    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.FINISHED });

    expect(
      browserTabModule.browserTab.startNotification,
    ).not.toHaveBeenCalled();
    // Sound still plays when focused (completion chime UX pattern)
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it("does not play sound when sound notifications are disabled", async () => {
    const { useSettings } = await import("#/hooks/query/use-settings");
    vi.mocked(useSettings).mockReturnValue({
      data: { enable_sound_notifications: false },
    } as ReturnType<typeof useSettings>);

    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.FINISHED });

    expect(mockPlay).not.toHaveBeenCalled();

    // Restore
    vi.mocked(useSettings).mockReturnValue({
      data: { enable_sound_notifications: true },
    } as ReturnType<typeof useSettings>);
  });

  it("does not trigger for non-notification states like RUNNING", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.LOADING } },
    );

    rerender({ state: AgentState.RUNNING });

    expect(
      browserTabModule.browserTab.startNotification,
    ).not.toHaveBeenCalled();
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("triggers notification on critical ERROR state", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.ERROR });

    expect(
      browserTabModule.browserTab.startNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it("shows a browser notification when enabled and tab is not focused", async () => {
    const { useSettings } = await import("#/hooks/query/use-settings");
    vi.mocked(useSettings).mockReturnValue({
      data: {
        enable_sound_notifications: false,
        enable_browser_notifications: true,
      },
    } as ReturnType<typeof useSettings>);

    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.FINISHED });

    expect(showBrowserNotification).toHaveBeenCalledTimes(1);

    // Restore
    vi.mocked(useSettings).mockReturnValue({
      data: { enable_sound_notifications: true },
    } as ReturnType<typeof useSettings>);
  });

  it("does not show a browser notification when the setting is disabled", () => {
    const { rerender } = renderHook(
      ({ state }) => useAgentNotification(state),
      { initialProps: { state: AgentState.RUNNING } },
    );

    rerender({ state: AgentState.FINISHED });

    expect(showBrowserNotification).not.toHaveBeenCalled();
  });
});
