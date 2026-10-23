import { createContext } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "mstar_post.theme";
export const ThemeContext = createContext<Theme>("dark");
