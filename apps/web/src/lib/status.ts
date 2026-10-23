/**
 * One status for a service in an environment: a deployment in progress wins; then the running instance (a failed
 * newer deploy leaves the previous version live); then a failed last deploy; otherwise the instance state.
 */
export function serviceStatus(instanceStatus: string | null | undefined, latestDeploymentStatus: string | null | undefined): string {
  if (latestDeploymentStatus && ["queued", "building", "deploying"].includes(latestDeploymentStatus)) return latestDeploymentStatus;
  if (instanceStatus && ["running", "sleeping", "crashed", "paused"].includes(instanceStatus)) return instanceStatus;
  if (latestDeploymentStatus === "failed") return "failed";
  return instanceStatus ?? "idle";
}
