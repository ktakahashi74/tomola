import { createContext, useContext } from "react";
import type { JoinedVillageNavigation } from "~/lib/village-navigation.server";
import type { FollowedVillageNavigation } from "~/lib/village-follows.server";

// What the places list (the side column and the drawer) needs, with the live unread counts already applied. Only a member's layout provides it.
export type NavigationData = { villages: JoinedVillageNavigation[]; followedVillages?: FollowedVillageNavigation[]; followedUnread: boolean; villagesEnabled: boolean };
export const NavigationDataContext = createContext<NavigationData | null>(null);
export const useNavigationData = () => useContext(NavigationDataContext);
