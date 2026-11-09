import { createContext, useContext } from "react";

export type NavigationUnread = { notifications: number; unreadCounts: Record<string, number> };
export const NavigationUnreadContext = createContext<((counts: NavigationUnread) => void) | null>(null);
export const useNavigationUnread = () => useContext(NavigationUnreadContext);
