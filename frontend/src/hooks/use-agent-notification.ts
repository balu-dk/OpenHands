import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { AgentState } from "#/types/agent-state";
import { browserTab } from "#/utils/browser-tab";
import { showBrowserNotification } from "#/utils/browser-notifications";
import { useSettings } from "#/hooks/query/use-settings";
import { AGENT_STATUS_MAP } from "#/utils/status";
import notificationSound from "#/assets/notification.mp3";

const NOTIFICATION_STATES: AgentState[] = [
  AgentState.AWAITING_USER_INPUT,
  AgentState.FINISHED,
  AgentState.AWAITING_USER_CONFIRMATION,
  // Critical failures (V1 maps both error and stuck execution statuses here).
  AgentState.ERROR,
];

/**
 * Hook that triggers browser tab flashing, notification sound, and OS-level
 * browser notifications when the agent transitions into a state that
 * requires user attention: task finished, awaiting user input/confirmation,
 * or a critical error.
 *
 * - Flashes the browser tab title when the tab is not focused.
 * - Plays a notification sound if enabled in settings.
 * - Shows an OS notification (if enabled in settings and permission granted)
 *   when the tab is not focused; clicking it focuses the tab.
 * - Stops flashing when the user focuses the tab.
 */
export function useAgentNotification(curAgentState: AgentState) {
  const { data: settings } = useSettings();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const prevStateRef = useRef<AgentState | undefined>(undefined);

  // Initialize audio only in browser environment, inside useEffect to
  // avoid side effects during render (React 18 strict mode, SSR safety).
  useEffect(() => {
    if (typeof window !== "undefined" && !audioRef.current) {
      audioRef.current = new Audio(notificationSound);
      audioRef.current.volume = 0.5;
    }
  }, []);

  const isSoundEnabled = settings?.enable_sound_notifications ?? false;
  const isBrowserNotificationEnabled =
    settings?.enable_browser_notifications ?? false;

  // Trigger notification only on actual state transitions into a
  // notification-worthy state — not when unrelated deps (e.g. settings) change.
  useEffect(() => {
    if (prevStateRef.current === curAgentState) return;
    prevStateRef.current = curAgentState;

    if (!NOTIFICATION_STATES.includes(curAgentState)) return;

    if (isSoundEnabled && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {
        // Ignore autoplay errors (browsers may block autoplay)
      });
    }

    if (typeof document !== "undefined" && !document.hasFocus()) {
      const i18nKey = AGENT_STATUS_MAP[curAgentState];
      const message = i18nKey ? t(i18nKey) : curAgentState;
      browserTab.startNotification(message);

      if (isBrowserNotificationEnabled) {
        // Tag by conversation + state so repeated transitions replace the
        // previous notification instead of stacking up.
        showBrowserNotification("OpenHands", {
          body: message,
          tag: `openhands-${conversationId ?? "conversation"}-${curAgentState}`,
        });
      }
    }
  }, [
    curAgentState,
    isSoundEnabled,
    isBrowserNotificationEnabled,
    conversationId,
    t,
  ]);

  // Stop tab notification when window gains focus
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleFocus = () => {
      browserTab.stopNotification();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      browserTab.stopNotification();
    };
  }, []);
}
