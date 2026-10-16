export type IconName =
  | "data"
  | "prepare"
  | "visualize"
  | "analyze"
  | "results"
  | "leaf"
  | "panel"
  | "shield"
  | "arrow";
const paths: Record<IconName, React.ReactNode> = {
  data: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 10h18M9 4v16M15 10v10" />
    </>
  ),
  prepare: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  visualize: (
    <>
      <path d="M4 3v17h17M8 16v-5M13 16V6M18 16V9" />
    </>
  ),
  analyze: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6M7 11l2-3 2 4 2-3" />
    </>
  ),
  results: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h3" />
    </>
  ),
  leaf: (
    <>
      <path d="M5 19C2 7 12 3 20 4c1 10-6 15-15 15ZM5 19 15 9" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16M18 9v6" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
