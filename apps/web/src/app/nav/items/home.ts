import { HouseIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "home",
  label: "Home",
  icon: HouseIcon,
  to: "/",
  exact: true,
  order: 0,
};
