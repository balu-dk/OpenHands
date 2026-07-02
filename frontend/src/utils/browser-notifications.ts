/**
 * Thin wrapper around the browser Notification API.
 *
 * Used by useAgentNotification to alert the user when the agent finishes,
 * needs input, or hits an error while the tab is hidden or unfocused.
 * All functions are safe to call in non-browser/unsupported environments
 * (they simply no-op).
 */

export const isBrowserNotificationSupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const getBrowserNotificationPermission = ():
  | NotificationPermission
  | "unsupported" => {
  if (!isBrowserNotificationSupported()) return "unsupported";
  return Notification.permission;
};

/**
 * Request notification permission from the user.
 * Returns true when permission is (already or newly) granted.
 */
export const requestBrowserNotificationPermission =
  async (): Promise<boolean> => {
    if (!isBrowserNotificationSupported()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const permission = await Notification.requestPermission();
    return permission === "granted";
  };

interface ShowBrowserNotificationOptions {
  body?: string;
  /** Dedupe key: a new notification with the same tag replaces the old one. */
  tag?: string;
}

/**
 * Show an OS-level notification. No-ops unless permission has been granted.
 * Clicking the notification focuses the OpenHands tab.
 */
export const showBrowserNotification = (
  title: string,
  options?: ShowBrowserNotificationOptions,
): void => {
  if (getBrowserNotificationPermission() !== "granted") return;

  try {
    const notification = new Notification(title, {
      body: options?.body,
      tag: options?.tag,
      icon: "/favicon.ico",
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some platforms (e.g. Android Chrome) throw for page-scoped
    // notifications; there is no graceful fallback without a service
    // worker, so silently ignore.
  }
};
