import type { ImportOptions } from "../domain/types";
export const defaultImportOptions: ImportOptions = {
  encoding: "utf-8",
  delimiter: ",",
  header: true,
  sheet: "",
  xlsxValues: "smart",
};
