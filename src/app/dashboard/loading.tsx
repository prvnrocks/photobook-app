import { RouteLoading } from "@/components/layout/RouteLoading";

export default function Loading() {
  return <RouteLoading width="wide" label="Loading your books…" cards={3} />;
}
