import { createContext, useContext } from "react";

// Downloads and printing can start long after their data was prepared.
export const ProjectAccess = createContext<(action: () => void) => Promise<void>>(async () => {});
export const useProjectAccess = () => useContext(ProjectAccess);
