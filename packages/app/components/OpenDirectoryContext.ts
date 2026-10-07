import { createContext, useContext } from "react";

/**
 * Lets a terminal ask the app to open the file browser at a directory (a
 * clicked path link that resolved to a folder) without threading a prop
 * through the whole workspace tree.
 */
export type OpenDirectory = (machineId: string, path: string) => void;

export const OpenDirectoryContext = createContext<OpenDirectory | undefined>(undefined);

export function useOpenDirectory(): OpenDirectory | undefined {
  return useContext(OpenDirectoryContext);
}
